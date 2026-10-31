import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createSandbox } from "./sandbox.mjs";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const RUN = 500;
const STAGING = { id: 42, name: "staging-review" };

// Minutes for --timeout and --register, seconds for --interval.
const FAST = ["--interval", "0.01", "--timeout", "0.02", "--register", "0.01"];

let sandbox;

function requireContexts(...contexts) {
  return [
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: contexts.map((context) => ({ context })),
      },
    },
  ];
}

function check(name, overrides = {}) {
  return { name, head_sha: HEAD, run_id: RUN, ...overrides };
}

function gate(name, overrides = {}) {
  return check(name, {
    gate: { environment: STAGING, can_approve: true, waitsAtPoll: 1 },
    ...overrides,
  });
}

function writeState(overrides = {}) {
  const { checkRuns = [], ...rest } = overrides;

  sandbox.writeState({
    repo: "acme/shop",
    labels: [],
    pr: {
      number: 7,
      state: "OPEN",
      headRefOid: HEAD,
      base: "main",
      labels: [],
    },
    reviews: [],
    comments: [],
    checkRuns: checkRuns.map((run, index) => ({ id: index + 1, ...run })),
    rules: [],
    ...rest,
  });
}

async function watch(target = "7", args = []) {
  const result = await sandbox.runScript("ship-it-ci-watch.mjs", [
    target,
    ...FAST,
    ...args,
  ]);

  assert.equal(result.code, 0, result.stderr);

  return JSON.parse(result.stdout);
}

function approvals() {
  return sandbox
    .ghCalls()
    .filter(
      ([command, flag, method, path]) =>
        command === "api" &&
        flag === "-X" &&
        method === "POST" &&
        path.endsWith("/pending_deployments"),
    );
}

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.remove();
});

describe("ship-it-ci-watch.mjs on a pull request", () => {
  test("waits for the required check to register, then for it to pass", async () => {
    writeState({
      rules: requireContexts("ci-success"),
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        check("ci-success", { appearsAtPoll: 3, completesAtPoll: 5 }),
        gate("approve-preview", {
          gate: { environment: STAGING, can_approve: true, waitsAtPoll: 4 },
        }),
        check("deploy-preview", { heldByGate: true }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.equal(output.pull_request, 7);
    assert.equal(output.head, HEAD);
    assert.deepEqual(output.required, ["ci-success"]);
    assert.deepEqual(output.watched, ["ci-success"]);
    assert.deepEqual(output.passed, ["ci-success"]);
    assert.deepEqual(output.pending, []);
    assert.deepEqual(output.gates, [
      {
        run_id: RUN,
        url: `https://github.com/acme/shop/actions/runs/${RUN}`,
        environment: "staging-review",
        environment_id: 42,
        can_approve: true,
        approved: false,
        jobs: ["approve-preview"],
        blocked: ["deploy-preview"],
      },
    ]);
    assert.deepEqual(approvals(), []);
  });

  test("reports none when the required check never registers", async () => {
    writeState({
      rules: requireContexts("ci-success"),
      checkRuns: [check("lint", { completesAtPoll: 1 })],
    });

    const output = await watch();

    assert.equal(output.result, "none");
    assert.deepEqual(output.missing, ["ci-success"]);
  });

  test("watches every check but a review service's and the gated ones when the merge requires none", async () => {
    writeState({
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        check("test", { completesAtPoll: 2 }),
        check("reviewbot-review:code-review", {
          run_id: null,
          completesAtPoll: 9999,
        }),
        gate("approve-preview", {
          gate: { environment: STAGING, can_approve: true, waitsAtPoll: 2 },
        }),
        check("deploy-preview", { heldByGate: true }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.required, []);
    assert.deepEqual(output.watched, ["lint", "test"]);
    assert.deepEqual(output.gates[0].jobs, ["approve-preview"]);
    assert.deepEqual(output.gates[0].blocked, ["deploy-preview"]);
    assert.ok(
      sandbox
        .ghCalls()
        .some(([, path]) =>
          path?.endsWith("branches/main/protection/required_status_checks"),
        ),
      "classic protection was read",
    );
  });

  test("ends as failed when a watched check fails, without waiting for the rest", async () => {
    writeState({
      checkRuns: [
        check("lint", { completesAtPoll: 1, conclusion: "failure" }),
        check("test", { completesAtPoll: 9999 }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "failed");
    assert.deepEqual(output.failed, [
      {
        name: "lint",
        conclusion: "failure",
        url: `https://github.com/acme/shop/actions/runs/${RUN}/job/1`,
        run_id: RUN,
        job_id: 1,
      },
    ]);
    assert.deepEqual(output.pending, [
      {
        name: "test",
        status: "in_progress",
        url: `https://github.com/acme/shop/actions/runs/${RUN}/job/2`,
      },
    ]);
  });

  test("ends as gated when the merge requires the gate itself", async () => {
    writeState({
      rules: requireContexts("approve-preview"),
      checkRuns: [gate("approve-preview")],
    });

    const output = await watch();

    assert.equal(output.result, "gated");
    assert.deepEqual(
      output.pending.map(({ name, status }) => ({ name, status })),
      [{ name: "approve-preview", status: "waiting" }],
    );
    assert.equal(output.gates[0].can_approve, true);
  });

  test("approves the gates the user can approve with --approve-gates and watches on", async () => {
    writeState({
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        gate("approve-preview"),
        check("deploy-preview", { heldByGate: true }),
      ],
    });

    const output = await watch("7", ["--approve-gates"]);

    assert.equal(output.result, "passed");
    assert.deepEqual(output.watched, [
      "approve-preview",
      "deploy-preview",
      "lint",
    ]);
    assert.deepEqual(output.passed, [
      "approve-preview",
      "deploy-preview",
      "lint",
    ]);
    assert.equal(output.gates[0].approved, true);
    assert.deepEqual(approvals(), [
      [
        "api",
        "-X",
        "POST",
        `repos/acme/shop/actions/runs/${RUN}/pending_deployments`,
        "-F",
        "environment_ids[]=42",
        "-f",
        "state=approved",
        "-f",
        "comment=Approved by ship-it for PR #7",
      ],
    ]);
  });

  test("leaves a gate the user cannot approve", async () => {
    writeState({
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        gate("approve-preview", {
          gate: { environment: STAGING, can_approve: false, waitsAtPoll: 1 },
        }),
      ],
    });

    const output = await watch("7", ["--approve-gates"]);

    assert.equal(output.result, "passed");
    assert.equal(output.gates[0].can_approve, false);
    assert.equal(output.gates[0].approved, false);
    assert.deepEqual(approvals(), []);
  });

  test("reports a timeout with the pending checks", async () => {
    writeState({ checkRuns: [check("lint", { completesAtPoll: 9999 })] });

    const output = await watch();

    assert.equal(output.result, "timeout");
    assert.deepEqual(
      output.pending.map(({ name, status }) => ({ name, status })),
      [{ name: "lint", status: "in_progress" }],
    );
  });

  test("stops when the head moves", async () => {
    writeState({
      pr: {
        number: 7,
        state: "OPEN",
        headRefOid: HEAD,
        base: "main",
        labels: [],
        headMovesAtPoll: 2,
        headMovesTo: OTHER_HEAD,
      },
      checkRuns: [check("lint", { completesAtPoll: 9999 })],
    });

    const output = await watch();

    assert.equal(output.result, "superseded");
    assert.equal(output.head, HEAD);
    assert.equal(output.head_moved_to, OTHER_HEAD);
  });

  test("stops when the pull request closes", async () => {
    writeState({
      pr: {
        number: 7,
        state: "OPEN",
        headRefOid: HEAD,
        base: "main",
        labels: [],
        closesAtPoll: 2,
      },
      checkRuns: [check("lint", { completesAtPoll: 9999 })],
    });

    const output = await watch();

    assert.equal(output.result, "closed");
    assert.match(output.reason, /merged/);
  });

  test("reads the required contexts from classic protection too", async () => {
    writeState({
      protection: { contexts: ["ci"], checks: [{ context: "ci" }] },
      checkRuns: [
        check("ci", { completesAtPoll: 1 }),
        check("lint", { completesAtPoll: 1, conclusion: "failure" }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.required, ["ci"]);
    assert.deepEqual(output.watched, ["ci"]);
  });

  test("counts a commit status among the checks", async () => {
    writeState({
      rules: requireContexts("coverage/coveralls"),
      statuses: [
        {
          id: 70,
          context: "coverage/coveralls",
          state: "success",
          target_url: "https://coveralls.io/builds/1",
        },
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["coverage/coveralls"]);
  });

  test("keeps the newest check run per name", async () => {
    writeState({
      checkRuns: [
        check("lint", { status: "completed", conclusion: "failure" }),
        check("lint", { completesAtPoll: 1, conclusion: "success" }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["lint"]);
  });

  test("takes the repository and number from a pull request URL, through the REST API only", async () => {
    writeState({ checkRuns: [check("lint", { completesAtPoll: 1 })] });

    const output = await watch("https://github.com/acme/shop/pull/7");

    assert.equal(output.repository, "acme/shop");
    assert.equal(output.result, "passed");
    assert.deepEqual(
      [...new Set(sandbox.ghCalls().map(([command]) => command))],
      ["api"],
    );
    assert.equal(
      sandbox.ghCalls().some((call) => call.includes("repos/{owner}/{repo}")),
      false,
    );
  });

  test("refuses a closed pull request", async () => {
    writeState({
      pr: { number: 7, state: "MERGED", headRefOid: HEAD, labels: [] },
    });

    const result = await sandbox.runScript("ship-it-ci-watch.mjs", ["7"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Pull request #7 on acme\/shop is merged/);
  });

  test("refuses a target that is neither a pull request nor a commit", async () => {
    writeState();

    const result = await sandbox.runScript("ship-it-ci-watch.mjs", ["main"]);

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /must be a number or a github.com pull request URL/,
    );
  });
});

describe("ship-it-ci-watch.mjs on a commit", () => {
  test("ends as gated when a run waits for an approval", async () => {
    writeState({
      checkRuns: [
        check("test", { completesAtPoll: 1 }),
        gate("approve-production", {
          gate: {
            environment: { id: 9, name: "production" },
            can_approve: true,
          },
        }),
        check("deploy-production", { heldByGate: true }),
      ],
    });

    const output = await watch(HEAD);

    assert.equal(output.result, "gated");
    assert.equal(output.commit, HEAD);
    assert.equal(output.pull_request, undefined);
    assert.deepEqual(output.watched, [
      "approve-production",
      "deploy-production",
      "test",
    ]);
    assert.deepEqual(
      output.pending.map(({ name, status }) => ({ name, status })),
      [
        { name: "approve-production", status: "waiting" },
        { name: "deploy-production", status: "queued" },
      ],
    );
    assert.equal(output.gates[0].environment, "production");
    assert.equal(
      sandbox.ghCalls().some(([, path]) => path?.includes("/pulls/")),
      false,
    );
  });

  test("approves the gate with --approve-gates and watches the deploy to its end", async () => {
    writeState({
      checkRuns: [
        check("test", { completesAtPoll: 1 }),
        gate("approve-production", {
          gate: {
            environment: { id: 9, name: "production" },
            can_approve: true,
          },
        }),
        check("deploy-production", { heldByGate: true }),
      ],
    });

    const output = await watch(HEAD, ["--approve-gates"]);

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, [
      "approve-production",
      "deploy-production",
      "test",
    ]);
    assert.equal(output.gates[0].approved, true);
    assert.match(approvals()[0].at(-1), new RegExp(`for ${HEAD}$`));
  });

  test("reports none when no check registers", async () => {
    writeState();

    const output = await watch(HEAD);

    assert.equal(output.result, "none");
    assert.deepEqual(output.watched, []);
  });
});
