import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import type { FakeCheck, FakeRule, FakeState } from "./fixtures/fake-gh";
import { createSandbox } from "./sandbox";
import type { Sandbox } from "./sandbox";

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

type CheckSpec = Omit<FakeCheck, "id">;

interface WatchOutput {
  result: string;
  repository: string;
  pull_request?: number;
  commit?: string;
  head?: string;
  head_moved_to?: string;
  reason?: string;
  requirements_known?: boolean;
  required: string[];
  watched: string[];
  passed: string[];
  failed: {
    name: string;
    conclusion: string | null;
    url: string | null;
    run_id: number | null;
    job_id: number | null;
  }[];
  pending: { name: string; status: string | null; url: string | null }[];
  missing: string[];
  gates: {
    run_id: number;
    url: string | null;
    environment: string;
    environment_id: number;
    can_approve: boolean;
    approved: boolean;
    approval_error?: string;
    jobs: string[];
  }[];
}

function isWatchOutput(value: unknown): value is WatchOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "result" in value &&
    "gates" in value &&
    Array.isArray(value.gates)
  );
}

function parseWatchOutput(stdout: string): WatchOutput {
  const output: unknown = JSON.parse(stdout);

  if (!isWatchOutput(output)) {
    throw new Error(`The watch printed no result: ${stdout}`);
  }

  return output;
}

// Each test runs the scripts as processes and waits through their polls.
setDefaultTimeout(60_000);

let sandbox: Sandbox;

function requireContexts(
  ...contexts: (string | { context: string; integration_id: number })[]
): FakeRule {
  return {
    type: "required_status_checks",
    parameters: {
      required_status_checks: contexts.map((context) =>
        typeof context === "string" ? { context } : context,
      ),
    },
  };
}

function requireWorkflows(...paths: string[]): FakeRule {
  return {
    type: "workflows",
    parameters: { workflows: paths.map((path) => ({ path })) },
  };
}

function check(name: string, overrides: Partial<CheckSpec> = {}): CheckSpec {
  return { name, head_sha: HEAD, run_id: RUN, ...overrides };
}

function gate(name: string, overrides: Partial<CheckSpec> = {}): CheckSpec {
  return check(name, {
    gate: { environment: STAGING, can_approve: true, waitsAtPoll: 1 },
    ...overrides,
  });
}

function writeState(
  overrides: Partial<Omit<FakeState, "checkRuns">> & {
    checkRuns?: CheckSpec[];
  } = {},
): void {
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
    rules: [],
    ...rest,
    checkRuns: checkRuns.map((run, index) =>
      Object.assign({ id: index + 1 }, run),
    ),
  });
}

async function watch(target = "7", args: string[] = []): Promise<WatchOutput> {
  const result = await sandbox.runScript("ship-it-ci-watch.ts", [
    target,
    ...FAST,
    ...args,
  ]);

  expect(result.code, result.stderr).toBe(0);

  return parseWatchOutput(result.stdout);
}

function approvals(): string[][] {
  return sandbox
    .ghCalls()
    .filter(
      ([command, flag, method, path]) =>
        command === "api" &&
        flag === "-X" &&
        method === "POST" &&
        path?.endsWith("/pending_deployments"),
    );
}

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.remove();
});

describe("ship-it-ci-watch.ts on a pull request", () => {
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

    expect(output.result).toBe("passed");
    expect(output.pull_request).toBe(7);
    expect(output.head).toBe(HEAD);
    expect(output.required).toEqual(["ci-success"]);
    expect(output.watched).toEqual(["ci-success"]);
    expect(output.passed).toEqual(["ci-success"]);
    expect(output.pending).toEqual([]);
    expect(output.gates).toEqual([
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
    expect(approvals()).toEqual([]);
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

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["ci-success"]);
  });

  test("reports none when the required check never registers and nothing runs", async () => {
    writeState({
      rules: [requireContexts("ci-success")],
      checkRuns: [check("lint", { completesAtPoll: 1 })],
    });

    const output = await watch("7", ["--register", SHORT]);

    expect(output.result).toBe("none");
    expect(output.missing).toEqual(["ci-success"]);
  });

  test("reports a required check that failed before the others register", async () => {
    writeState({
      rules: [requireContexts("ci-success", "lint")],
      checkRuns: [check("lint", { completesAtPoll: 1, conclusion: "failure" })],
    });

    const output = await watch();

    expect(output.result).toBe("failed");
    expect(output.failed.map(({ name }) => name)).toEqual(["lint"]);
    expect(output.missing).toEqual(["ci-success"]);
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

    expect(output.result).toBe("passed");
    expect(output.required).toEqual(["ci-success", SECRET_SCAN]);
    expect(output.watched).toEqual(["ci-success", "gitleaks"]);
    expect(output.passed).toEqual(["ci-success", "gitleaks"]);
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

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["report", "scan"]);
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

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["test", "test"]);
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

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["Critical alert SLA gate", "lint"]);
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

    expect(output.result).toBe("passed");
    expect(output.watched).toEqual(["ci-success"]);
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

    expect(output.result).toBe("none");
    expect(output.missing).toEqual(["ci-success"]);
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

    expect(output.result).toBe("passed");
    expect(output.required).toEqual([]);
    expect(output.watched).toEqual(["lint", "test"]);
    expect(output.gates[0]?.jobs).toEqual(["approve-preview"]);
    expect(
      sandbox
        .ghCalls()
        .some(([, path]) =>
          path?.endsWith("branches/main/protection/required_status_checks"),
        ),
      "classic protection was read",
    ).toBe(true);
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

    expect(output.result).toBe("passed");
    expect(output.watched).toEqual(["lint"]);
    expect(output.pending).toEqual([]);
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

    expect(output.result).toBe("gated");
    expect(output.requirements_known).toBe(false);
    expect(output.required).toEqual([]);
    expect(output.gates[0]?.can_approve).toBe(true);
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

    expect(output.result).toBe("passed");
    expect(output.watched).toEqual(["lint"]);
  });

  test("ends as failed when a watched check fails, without waiting for the rest", async () => {
    writeState({
      checkRuns: [
        check("lint", { completesAtPoll: 1, conclusion: "failure" }),
        check("test", { completesAtPoll: 9999 }),
      ],
    });

    const output = await watch();

    expect(output.result).toBe("failed");
    expect(output.failed).toEqual([
      {
        name: "lint",
        conclusion: "failure",
        url: `https://github.com/acme/shop/actions/runs/${RUN}/job/1`,
        run_id: RUN,
        job_id: 1,
      },
    ]);
    expect(
      output.pending.map(({ name, status }) => ({ name, status })),
    ).toEqual([
      { name: "test", status: "in_progress" },
      { name: ".github/workflows/ci.yml", status: "in_progress" },
    ]);
  });

  test("ends as gated when the merge requires the gate itself", async () => {
    writeState({
      rules: [requireContexts("approve-preview")],
      checkRuns: [gate("approve-preview")],
    });

    const output = await watch();

    expect(output.result).toBe("gated");
    expect(
      output.pending.map(({ name, status }) => ({ name, status })),
    ).toEqual([{ name: "approve-preview", status: "waiting" }]);
    expect(output.gates[0]?.can_approve).toBe(true);
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

    expect(output.result).toBe("passed");
    expect(output.watched).toEqual([
      "approve-preview",
      "deploy-preview",
      "lint",
    ]);
    expect(output.passed).toEqual([
      "approve-preview",
      "deploy-preview",
      "lint",
    ]);
    expect(output.gates[0]?.approved).toBe(true);
    expect(approvals()).toEqual([
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

    expect(output.result).toBe("passed");
    expect(
      output.gates.map(({ environment, approved }) => ({
        environment,
        approved,
      })),
    ).toEqual([
      { environment: "staging-review", approved: true },
      { environment: "production", approved: false },
    ]);
    expect(approvals().length).toBe(1);
    expect(approvals()[0]?.includes("environment_ids[]=42")).toBe(true);
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

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["deploy-preview"]);
    expect(output.gates[0]?.approved).toBe(true);
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

    expect(output.result).toBe("passed");
    expect(output.gates[0]?.can_approve).toBe(false);
    expect(output.gates[0]?.approved).toBe(false);
    expect(approvals()).toEqual([]);
  });

  test("refuses --approve-gates with an empty list", async () => {
    writeState();

    const result = await sandbox.runScript("ship-it-ci-watch.ts", [
      "7",
      "--approve-gates=,",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /--approve-gates option needs environment names/,
    );
  });

  test("watches a queued job of a run that waits for a reviewer", async () => {
    writeState({
      checkRuns: [
        check("lint", { completesAtPoll: 1 }),
        gate("approve-preview"),
        check("test", {
          appearsAtPoll: 1,
          completesAtPoll: 4,
          queuedUntil: 3,
        }),
      ],
    });

    const output = await watch();

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["lint", "test"]);
    expect(output.gates[0]?.jobs).toEqual(["approve-preview"]);
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

    expect(output.result).toBe("passed");
    expect(output.required).toEqual([SECRET_SCAN]);
    expect(output.passed).toEqual(["gitleaks"]);
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

    expect(output.result).toBe("passed");
    expect(output.gates[0]?.approved).toBe(false);
    expect(output.gates[0]?.approval_error).toMatch(/refused the approval/);
    expect(approvals().length).toBe(1);
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

    expect(output.result).toBe("passed");
    expect(output.watched).toEqual(["deploy-wait", "lint"]);
    expect(output.gates).toEqual([]);
  });

  test("reports a timeout with the pending checks", async () => {
    writeState({ checkRuns: [check("lint", { completesAtPoll: 9999 })] });

    const output = await watch("7", ["--timeout", SHORT]);

    expect(output.result).toBe("timeout");
    expect(
      output.pending.map(({ name, status }) => ({ name, status })),
    ).toEqual([
      { name: "lint", status: "in_progress" },
      { name: ".github/workflows/ci.yml", status: "in_progress" },
    ]);
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

    expect(output.result).toBe("superseded");
    expect(output.head).toBe(HEAD);
    expect(output.head_moved_to).toBe(OTHER_HEAD);
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

    expect(output.result).toBe("closed");
    expect(output.reason).toMatch(/merged/);
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

    expect(output.result).toBe("passed");
    expect(output.required).toEqual(["ci"]);
    expect(output.watched).toEqual(["ci"]);
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

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["coverage/coveralls"]);
  });

  test("keeps a check run and a commit status of the same name apart", async () => {
    writeState({
      rules: [requireContexts("ci")],
      statuses: [{ id: 70, context: "ci", state: "failure" }],
      checkRuns: [check("ci", { completesAtPoll: 1 })],
    });

    const output = await watch();

    expect(output.result).toBe("failed");
    expect(output.passed).toEqual(["ci"]);
    expect(output.failed[0]?.name).toBe("ci");
  });

  test("keeps the newest check run per name", async () => {
    writeState({
      checkRuns: [
        check("lint", { status: "completed", conclusion: "failure" }),
        check("lint", { completesAtPoll: 1, conclusion: "success" }),
      ],
    });

    const output = await watch();

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["lint"]);
  });

  test("takes the repository and number from a pull request URL, through the REST API only", async () => {
    writeState({ checkRuns: [check("lint", { completesAtPoll: 1 })] });

    const output = await watch("https://github.com/acme/shop/pull/7");

    expect(output.repository).toBe("acme/shop");
    expect(output.result).toBe("passed");
    expect([...new Set(sandbox.ghCalls().map(([command]) => command))]).toEqual(
      ["api"],
    );
    expect(
      sandbox.ghCalls().some((call) => call.includes("repos/{owner}/{repo}")),
    ).toBe(false);
  });

  test("refuses a closed pull request", async () => {
    writeState({
      pr: { number: 7, state: "MERGED", headRefOid: HEAD, labels: [] },
    });

    const result = await sandbox.runScript("ship-it-ci-watch.ts", ["7"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Pull request #7 on acme\/shop is merged/);
  });

  test("refuses a target that is neither a pull request nor a commit", async () => {
    writeState();

    const result = await sandbox.runScript("ship-it-ci-watch.ts", ["main"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /must be a number or a github.com pull request URL/,
    );
  });

  test("counts a required review service's check as the head's first check", async () => {
    writeState({
      rules: [requireContexts("reviewbot-review:code-review")],
      checkRuns: [
        check("reviewbot-review:code-review", {
          run_id: null,
          completesAtPoll: 1,
        }),
      ],
    });

    const output = await watch("7", ["--first-check", SHORT]);

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["reviewbot-review:code-review"]);
  });

  test("fails when the required check's head shows nothing within --first-check", async () => {
    writeState({ rules: [requireContexts("ci-success")] });

    const result = await sandbox.runScript("ship-it-ci-watch.ts", [
      "7",
      ...FAST,
      "--first-check",
      SHORT,
    ]);
    const output = parseWatchOutput(result.stdout);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`^Nothing appeared on ${HEAD}`));
    expect(output.result).toBe("none");
    expect(output.pull_request).toBe(7);
    expect(output.missing).toEqual(["ci-success"]);
  });
});

describe("ship-it-ci-watch.ts on a commit", () => {
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

    expect(output.result).toBe("gated");
    expect(output.commit).toBe(HEAD);
    expect(output.pull_request).toBe(undefined);
    expect(output.watched).toEqual(["approve-production", "test"]);
    expect(
      output.pending.map(({ name, status }) => ({ name, status })),
    ).toEqual([{ name: "approve-production", status: "waiting" }]);
    expect(output.gates[0]?.environment).toBe("production");
    expect(
      sandbox.ghCalls().some(([, path]) => path?.includes("/pulls/")),
    ).toBe(false);
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

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual([
      "approve-production",
      "deploy-production",
      "test",
    ]);
    expect(output.gates[0]?.approved).toBe(true);
    expect(approvals()[0]?.at(-1)).toMatch(new RegExp(`for ${HEAD}$`));
  });

  test("waits for a run's later jobs to register before it passes", async () => {
    writeState({
      checkRuns: [
        check("build", { completesAtPoll: 1 }),
        check("deploy", { appearsAtPoll: 3, completesAtPoll: 4 }),
      ],
    });

    const output = await watch(HEAD);

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["build", "deploy"]);
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

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["build", "deploy"]);
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

    expect(output.result).toBe("gated");
    expect(output.gates[0]?.approval_error).toMatch(/refused the approval/);
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

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["test"]);
    expect(output.failed).toEqual([]);
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

    expect(output.result).toBe("passed");
    expect(output.failed).toEqual([]);
  });

  test("waits for a rerun run's jobs instead of counting its old failure", async () => {
    writeState({
      runs: { [RUN]: { staleFailure: true } },
      checkRuns: [check("test", { completesAtPoll: 3 })],
    });

    const output = await watch(HEAD);

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["test"]);
  });

  test("reports a run that failed after its jobs passed", async () => {
    writeState({
      runs: { [RUN]: { conclusion: "failure" } },
      checkRuns: [check("setup", { completesAtPoll: 1 })],
    });

    const output = await watch(HEAD);

    expect(output.result).toBe("failed");
    expect(output.passed).toEqual(["setup"]);
    expect(
      output.failed.map(({ name, conclusion }) => ({ name, conclusion })),
    ).toEqual([{ name: ".github/workflows/ci.yml", conclusion: "failure" }]);
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

    expect(output.result).toBe("failed");
    expect(output.failed).toEqual([
      {
        name: ".github/workflows/deploy.yml",
        conclusion: "startup_failure",
        url: `https://github.com/acme/shop/actions/runs/${OTHER_RUN}`,
        run_id: OTHER_RUN,
        job_id: null,
      },
    ]);
  });

  test("fails when nothing appears on the commit within --first-check", async () => {
    writeState();

    const result = await sandbox.runScript("ship-it-ci-watch.ts", [
      HEAD,
      ...FAST,
      "--register",
      SHORT,
      "--first-check",
      SHORT,
    ]);
    const output = parseWatchOutput(result.stdout);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      new RegExp(`^Nothing appeared on ${HEAD} within \\d+ seconds`),
    );
    expect(result.stderr).toMatch(/Either CI never started for this head/);
    expect(output.result).toBe("none");
    expect(output.watched).toEqual([]);
  });

  test("fails when nothing appears before the watch times out", async () => {
    writeState();

    const result = await sandbox.runScript("ship-it-ci-watch.ts", [
      HEAD,
      ...FAST,
      "--timeout",
      SHORT,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^Nothing appeared on /);
    expect(parseWatchOutput(result.stdout).result).toBe("none");
  });

  test("waits past --register for the first check to appear", async () => {
    writeState({
      checkRuns: [
        check("lint", { run_id: null, appearsAtPoll: 15, completesAtPoll: 16 }),
      ],
    });

    const output = await watch(HEAD, ["--register", SHORT]);

    expect(output.result).toBe("passed");
    expect(output.passed).toEqual(["lint"]);
  });
});
