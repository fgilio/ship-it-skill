import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createSandbox } from "./sandbox.mjs";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const RUN = 500;
const OTHER_RUN = 600;
const STAGING = { id: 42, name: "staging-review" };
const PRODUCTION = { id: 9, name: "production" };
const ACTIONS_APP_ID = 15368;
const SECRET_SCAN = ".github/workflows/secret-scan.yml";

// Minutes for --timeout and --register, seconds for --interval. The windows
// are wide, since a poll takes several gh calls: a test that expects a
// window to run out passes a short one of its own.
const FAST = ["--interval", "0.01", "--timeout", "0.5", "--register", "0.25"];
const SHORT = "0.005";

let sandbox;

function requireContexts(...contexts) {
  return {
    type: "required_status_checks",
    parameters: {
      required_status_checks: contexts.map((context) =>
        typeof context === "string" ? { context } : context,
      ),
    },
  };
}

function requireWorkflows(...paths) {
  return {
    type: "workflows",
    parameters: { workflows: paths.map((path) => ({ path })) },
  };
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
      rules: [requireContexts("ci-success")],
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
      },
    ]);
    assert.deepEqual(approvals(), []);
  });

  test("keeps waiting for a required check while other checks still run", async () => {
    writeState({
      rules: [requireContexts("ci-success")],
      checkRuns: [
        check("test", { completesAtPoll: 8 }),
        check("ci-success", { appearsAtPoll: 8, completesAtPoll: 9 }),
      ],
    });

    const output = await watch("7", ["--register", SHORT]);

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["ci-success"]);
  });

  test("reports none when the required check never registers and nothing runs", async () => {
    writeState({
      rules: [requireContexts("ci-success")],
      checkRuns: [check("lint", { completesAtPoll: 1 })],
    });

    const output = await watch("7", ["--register", SHORT]);

    assert.equal(output.result, "none");
    assert.deepEqual(output.missing, ["ci-success"]);
  });

  test("reports a required check that failed before the others register", async () => {
    writeState({
      rules: [requireContexts("ci-success", "lint")],
      checkRuns: [check("lint", { completesAtPoll: 1, conclusion: "failure" })],
    });

    const output = await watch();

    assert.equal(output.result, "failed");
    assert.deepEqual(
      output.failed.map(({ name }) => name),
      ["lint"],
    );
    assert.deepEqual(output.missing, ["ci-success"]);
  });

  test("requires the jobs of a required workflow", async () => {
    writeState({
      rules: [requireContexts("ci-success"), requireWorkflows(SECRET_SCAN)],
      runs: { [OTHER_RUN]: { path: SECRET_SCAN } },
      checkRuns: [
        check("ci-success", { completesAtPoll: 1 }),
        check("lint", { completesAtPoll: 1 }),
        check("gitleaks", { run_id: OTHER_RUN, completesAtPoll: 3 }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.required, ["ci-success", SECRET_SCAN]);
    assert.deepEqual(output.watched, ["ci-success", "gitleaks"]);
    assert.deepEqual(output.passed, ["ci-success", "gitleaks"]);
  });

  test("keeps a required workflow's run until its later jobs register and end", async () => {
    writeState({
      rules: [requireWorkflows(SECRET_SCAN)],
      runs: { [OTHER_RUN]: { path: SECRET_SCAN } },
      checkRuns: [
        check("scan", { run_id: OTHER_RUN, completesAtPoll: 1 }),
        check("report", {
          run_id: OTHER_RUN,
          appearsAtPoll: 3,
          completesAtPoll: 4,
        }),
        check("lint", { completesAtPoll: 1 }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["report", "scan"]);
  });

  test("keeps same-named jobs of two workflows apart", async () => {
    writeState({
      rules: [requireWorkflows(".github/workflows/ci.yml", SECRET_SCAN)],
      runs: { [OTHER_RUN]: { path: SECRET_SCAN } },
      checkRuns: [
        check("test", { completesAtPoll: 1 }),
        check("test", { run_id: OTHER_RUN, completesAtPoll: 3 }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["test", "test"]);
  });

  test("goes on when a check's run cannot be read", async () => {
    writeState({
      runs: { [OTHER_RUN]: { missing: true } },
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        check("Critical alert SLA gate", {
          run_id: OTHER_RUN,
          completesAtPoll: 2,
        }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["Critical alert SLA gate", "lint"]);
  });

  test("matches a required context to the app the rule names", async () => {
    writeState({
      rules: [
        requireContexts({
          context: "ci-success",
          integration_id: ACTIONS_APP_ID,
        }),
      ],
      checkRuns: [
        check("ci-success", { app_id: 999, completesAtPoll: 1 }),
        check("ci-success", { appearsAtPoll: 2, completesAtPoll: 3 }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.watched, ["ci-success"]);
  });

  test("does not take another app's check for a required context", async () => {
    writeState({
      rules: [
        requireContexts({
          context: "ci-success",
          integration_id: ACTIONS_APP_ID,
        }),
      ],
      checkRuns: [check("ci-success", { app_id: 999, completesAtPoll: 1 })],
    });

    const output = await watch("7", ["--register", SHORT]);

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
    assert.ok(
      sandbox
        .ghCalls()
        .some(([, path]) =>
          path?.endsWith("branches/main/protection/required_status_checks"),
        ),
      "classic protection was read",
    );
  });

  test("does not wait for a review service's own run", async () => {
    writeState({
      runs: { 700: { path: ".github/workflows/review.yml" } },
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        check("reviewbot-review:code-review", {
          run_id: 700,
          completesAtPoll: 9999,
        }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.watched, ["lint"]);
    assert.deepEqual(output.pending, []);
  });

  test("holds for a gate when the classic protection cannot be read", async () => {
    writeState({
      protection: { forbidden: true },
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        gate("approve-preview"),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "gated");
    assert.equal(output.requirements_known, false);
    assert.deepEqual(output.required, []);
    assert.equal(output.gates[0].can_approve, true);
  });

  test("does not let a review service's check alone count as registered", async () => {
    writeState({
      checkRuns: [
        check("reviewbot-review:code-review", {
          run_id: null,
          completesAtPoll: 9999,
        }),
        check("lint", { appearsAtPoll: 3, completesAtPoll: 4 }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.watched, ["lint"]);
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
    assert.deepEqual(
      output.pending.map(({ name, status }) => ({ name, status })),
      [
        { name: "test", status: "in_progress" },
        { name: ".github/workflows/ci.yml", status: "in_progress" },
      ],
    );
  });

  test("ends as gated when the merge requires the gate itself", async () => {
    writeState({
      rules: [requireContexts("approve-preview")],
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

  test("approves only the environments --approve-gates names", async () => {
    writeState({
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        gate("approve-preview"),
        gate("approve-production", {
          gate: { environment: PRODUCTION, can_approve: true, waitsAtPoll: 1 },
        }),
      ],
    });

    const output = await watch("7", ["--approve-gates=staging-review"]);

    assert.equal(output.result, "passed");
    assert.deepEqual(
      output.gates.map(({ environment, approved }) => ({
        environment,
        approved,
      })),
      [
        { environment: "staging-review", approved: true },
        { environment: "production", approved: false },
      ],
    );
    assert.equal(approvals().length, 1);
    assert.ok(approvals()[0].includes("environment_ids[]=42"));
  });

  test("approves a gate that holds a required job before giving up on it", async () => {
    writeState({
      rules: [requireContexts("deploy-preview")],
      checkRuns: [
        gate("approve-preview"),
        check("deploy-preview", { heldByGate: true }),
      ],
    });

    const output = await watch("7", ["--approve-gates", "--register", SHORT]);

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["deploy-preview"]);
    assert.equal(output.gates[0].approved, true);
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

  test("refuses --approve-gates with an empty list", async () => {
    writeState();

    const result = await sandbox.runScript("ship-it-ci-watch.mjs", [
      "7",
      "--approve-gates=,",
    ]);

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /--approve-gates option needs environment names/,
    );
  });

  test("watches a queued job of a run that waits for a reviewer", async () => {
    writeState({
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        gate("approve-preview"),
        check("test", {
          status: undefined,
          appearsAtPoll: 1,
          completesAtPoll: 4,
          queuedUntil: 3,
        }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["lint", "test"]);
    assert.deepEqual(output.gates[0].jobs, ["approve-preview"]);
  });

  test("matches a required workflow whose run names its path with a ref", async () => {
    writeState({
      rules: [requireWorkflows(SECRET_SCAN)],
      runs: { [OTHER_RUN]: { path: `${SECRET_SCAN}@main` } },
      checkRuns: [
        check("gitleaks", { run_id: OTHER_RUN, completesAtPoll: 2 }),
        check("lint", { completesAtPoll: 1 }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.required, [SECRET_SCAN]);
    assert.deepEqual(output.passed, ["gitleaks"]);
  });

  test("keeps a refused approval on the gate and reports the watch", async () => {
    writeState({
      runs: { [RUN]: { refusesApproval: true } },
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        gate("approve-preview"),
      ],
    });

    const output = await watch("7", ["--approve-gates"]);

    assert.equal(output.result, "passed");
    assert.equal(output.gates[0].approved, false);
    assert.match(output.gates[0].approval_error, /refused the approval/);
    assert.equal(approvals().length, 1);
  });

  test("waits through an environment's timer, which ends on its own", async () => {
    writeState({
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        gate("deploy-wait", {
          gate: {
            environment: STAGING,
            reviewers: [],
            wait_timer: 5,
            waitsAtPoll: 1,
            endsAtPoll: 3,
          },
        }),
      ],
    });

    const output = await watch();

    assert.equal(output.result, "passed");
    assert.deepEqual(output.watched, ["deploy-wait", "lint"]);
    assert.deepEqual(output.gates, []);
  });

  test("reports a timeout with the pending checks", async () => {
    writeState({ checkRuns: [check("lint", { completesAtPoll: 9999 })] });

    const output = await watch("7", ["--timeout", SHORT]);

    assert.equal(output.result, "timeout");
    assert.deepEqual(
      output.pending.map(({ name, status }) => ({ name, status })),
      [
        { name: "lint", status: "in_progress" },
        { name: ".github/workflows/ci.yml", status: "in_progress" },
      ],
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

  test("reads the required contexts from classic protection, each once", async () => {
    writeState({
      protection: {
        contexts: ["ci"],
        checks: [{ context: "ci", app_id: ACTIONS_APP_ID }],
      },
      checkRuns: [
        check("ci", { completesAtPoll: 1 }),
        check("ci", { app_id: 999, completesAtPoll: 1, conclusion: "failure" }),
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
      rules: [requireContexts("coverage/coveralls")],
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

  test("keeps a check run and a commit status of the same name apart", async () => {
    writeState({
      rules: [requireContexts("ci")],
      statuses: [{ id: 70, context: "ci", state: "failure" }],
      checkRuns: [check("ci", { completesAtPoll: 1 })],
    });

    const output = await watch();

    assert.equal(output.result, "failed");
    assert.deepEqual(output.passed, ["ci"]);
    assert.equal(output.failed[0].name, "ci");
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
  test("ends as gated when a run waits for a reviewer", async () => {
    writeState({
      checkRuns: [
        check("test", { completesAtPoll: 1 }),
        gate("approve-production", {
          gate: { environment: PRODUCTION, can_approve: true },
        }),
        check("deploy-production", { heldByGate: true }),
      ],
    });

    const output = await watch(HEAD);

    assert.equal(output.result, "gated");
    assert.equal(output.commit, HEAD);
    assert.equal(output.pull_request, undefined);
    assert.deepEqual(output.watched, ["approve-production", "test"]);
    assert.deepEqual(
      output.pending.map(({ name, status }) => ({ name, status })),
      [{ name: "approve-production", status: "waiting" }],
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
          gate: { environment: PRODUCTION, can_approve: true },
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

  test("waits for a run's later jobs to register before it passes", async () => {
    writeState({
      checkRuns: [
        check("build", { completesAtPoll: 1 }),
        check("deploy", { appearsAtPoll: 3, completesAtPoll: 4 }),
      ],
    });

    const output = await watch(HEAD);

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["build", "deploy"]);
  });

  test("waits for a run that exists before its first job registers", async () => {
    writeState({
      runs: { [OTHER_RUN]: { path: ".github/workflows/deploy.yml" } },
      checkRuns: [
        check("build", { completesAtPoll: 1 }),
        check("deploy", {
          run_id: OTHER_RUN,
          appearsAtPoll: 3,
          completesAtPoll: 4,
        }),
      ],
    });

    const output = await watch(HEAD);

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["build", "deploy"]);
  });

  test("ends a commit's watch as gated when the approval is refused", async () => {
    writeState({
      runs: { [RUN]: { refusesApproval: true } },
      checkRuns: [
        check("test", { completesAtPoll: 1 }),
        gate("approve-production", {
          gate: { environment: PRODUCTION, can_approve: true },
        }),
      ],
    });

    const output = await watch(HEAD, ["--approve-gates"]);

    assert.equal(output.result, "gated");
    assert.match(output.gates[0].approval_error, /refused the approval/);
  });

  test("does not count a failed run a newer run of the workflow replaced", async () => {
    writeState({
      runs: { 800: { path: ".github/workflows/ci.yml" } },
      checkRuns: [
        check("test", { status: "completed", conclusion: "failure" }),
        check("test", { run_id: 800, completesAtPoll: 1 }),
      ],
    });

    const output = await watch(HEAD);

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["test"]);
    assert.deepEqual(output.failed, []);
  });

  test("lets a failed review job speak for its run instead of the run's conclusion", async () => {
    writeState({
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        check("reviewbot-review:code-review", {
          completesAtPoll: 1,
          conclusion: "failure",
        }),
      ],
    });

    const output = await watch(HEAD);

    assert.equal(output.result, "passed");
    assert.deepEqual(output.failed, []);
  });

  test("waits for a rerun run's jobs instead of counting its old failure", async () => {
    writeState({
      runs: { [RUN]: { staleFailure: true } },
      checkRuns: [check("test", { completesAtPoll: 3 })],
    });

    const output = await watch(HEAD);

    assert.equal(output.result, "passed");
    assert.deepEqual(output.passed, ["test"]);
  });

  test("reports a run that failed after its jobs passed", async () => {
    writeState({
      runs: { [RUN]: { conclusion: "failure" } },
      checkRuns: [check("setup", { completesAtPoll: 1 })],
    });

    const output = await watch(HEAD);

    assert.equal(output.result, "failed");
    assert.deepEqual(output.passed, ["setup"]);
    assert.deepEqual(
      output.failed.map(({ name, conclusion }) => ({ name, conclusion })),
      [{ name: ".github/workflows/ci.yml", conclusion: "failure" }],
    );
  });

  test("reports a run that failed before any job ran", async () => {
    writeState({
      runs: {
        [OTHER_RUN]: {
          path: ".github/workflows/deploy.yml",
          conclusion: "startup_failure",
        },
      },
      checkRuns: [check("build", { completesAtPoll: 1 })],
    });

    const output = await watch(HEAD);

    assert.equal(output.result, "failed");
    assert.deepEqual(output.failed, [
      {
        name: ".github/workflows/deploy.yml",
        conclusion: "startup_failure",
        url: `https://github.com/acme/shop/actions/runs/${OTHER_RUN}`,
        run_id: OTHER_RUN,
        job_id: null,
      },
    ]);
  });

  test("reports none when no check registers", async () => {
    writeState();

    const output = await watch(HEAD, ["--register", SHORT]);

    assert.equal(output.result, "none");
    assert.deepEqual(output.watched, []);
  });
});
