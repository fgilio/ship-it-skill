#!/usr/bin/env bun
// Stands in for the GitHub CLI: answers the calls the scripts make from a
// state file, and plays each scripted outcome at its poll.
//
// State (FAKE_GH_STATE, rewritten on every call): FakeState below.
//
// Review outcomes: an outcome shows up `afterPolls` review listings after its
// request, and holds one of: review {}, refusal "<reason>", check
// { conclusion, title }, headMovesTo "<sha>", state "<pull request state>".
// labelPages, when set, replaces the one page of labels.
//
// CI watch: every listing of a commit's check runs without a name filter is
// one poll. A check run with a `status` is served as is. Without one, its
// status follows the poll count: hidden before `appearsAtPoll`, queued before
// `queuedUntil`, in progress before `completesAtPoll`, then completed with its
// `conclusion`. A check with
// `gate { environment, can_approve, reviewers, waitsAtPoll, endsAtPoll }`
// waits from `waitsAtPoll`: with reviewers, until its environment is approved,
// then it completes on the next poll; without reviewers (a timer), until
// `endsAtPoll`. A check with `heldByGate` does not register until its run has
// an approval, then completes two polls later. A run exists for every run id
// a check names, and for every entry of `runs`, which holds a run's workflow
// `path`, `missing` for a run the repository cannot serve, `appearsAtPoll`
// for one created late, `conclusion` for one that ended with no job,
// `staleFailure` for one that shows its old failure while its jobs run again,
// and `refusesApproval` for one whose environment refuses the approval. A run
// is in progress while any of its checks has not registered. The pull
// request's head moves at `headMovesAtPoll` and the pull request closes at
// `closesAtPoll`.
//
// FAKE_GH_STALL_ON stalls any call whose arguments contain it.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

interface Environment {
  id: number;
  name: string;
}

interface FakeGate {
  environment: Environment;
  can_approve?: boolean;
  reviewers?: unknown[];
  wait_timer?: number;
  waitsAtPoll?: number;
  endsAtPoll?: number;
}

export interface FakeCheck {
  id: number;
  name: string;
  head_sha: string;
  run_id?: number | null;
  app_id?: number;
  status?: string;
  conclusion?: string;
  started_at?: string;
  output?: { title: string | null };
  details_url?: string;
  appearsAtPoll?: number;
  queuedUntil?: number;
  completesAtPoll?: number;
  gate?: FakeGate;
  heldByGate?: boolean;
}

interface FakeRun {
  path?: string;
  missing?: boolean;
  appearsAtPoll?: number;
  conclusion?: string;
  staleFailure?: boolean;
  refusesApproval?: boolean;
}

interface FakePullRequest {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
  base?: string;
  labels: { name: string }[];
  headMovesAtPoll?: number;
  headMovesTo?: string;
  closesAtPoll?: number;
  closesAs?: "CLOSED" | "MERGED";
}

interface FakeOutcome {
  afterPolls?: number;
  review?: { body?: string };
  refusal?: string;
  check?: { conclusion: string; title: string };
  headMovesTo?: string;
  state?: FakePullRequest["state"];
}

interface FakeLabel {
  name: string;
  description: string;
}

interface FakeReview {
  id: number;
  body: string;
  html_url?: string;
  submitted_at: string;
  state?: string;
}

interface FakeComment {
  id: number;
  body: string;
  html_url?: string;
  created_at: string;
}

interface FakeStatus {
  id: number;
  context: string;
  state: string;
  target_url?: string;
  sha?: string;
}

export interface FakeRule {
  type: string;
  parameters: Record<string, unknown>;
}

export interface FakeState {
  repo: string;
  labels: FakeLabel[];
  labelPages?: FakeLabel[][];
  pr: FakePullRequest;
  reviews: FakeReview[];
  comments: FakeComment[];
  checkRuns: FakeCheck[];
  statuses?: FakeStatus[];
  rules?: FakeRule[];
  protection?:
    | { forbidden: true }
    | { contexts?: string[]; checks?: { context: string; app_id: number }[] };
  runs?: Record<number, FakeRun>;
  outcomes?: Record<string, FakeOutcome[]>;
  polls?: number;
  watchPolls?: number;
  requests?: Record<string, { count: number; atPoll: number }>;
  played?: string[];
  approvals?: { run_id: number; environment_id: number; atPoll: number }[];
}

/**
 * The state file is written by the tests through FakeState, so the
 * shape is checked at its top level only.
 */
function isFakeState(value: unknown): value is FakeState {
  return (
    typeof value === "object" &&
    value !== null &&
    "repo" in value &&
    typeof value.repo === "string" &&
    "pr" in value &&
    typeof value.pr === "object" &&
    "checkRuns" in value &&
    Array.isArray(value.checkRuns)
  );
}

interface ServedCheck {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  output: { title: string | null };
  app: { id: number; slug: string };
  html_url: string | null;
  details_url: string;
}

const ACTIONS_APP_ID = 15368;
const DEFAULT_REVIEWERS = [{ type: "Team", reviewer: { name: "Core Team" } }];

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE ?? "";
const parsedState: unknown = JSON.parse(readFileSync(statePath, "utf8"));

if (!isFakeState(parsedState)) {
  throw new Error(`The fake gh state in ${statePath} is not a FakeState.`);
}

const state = parsedState;
const requests = (state.requests ??= {});
const played = (state.played ??= []);
const approvals = (state.approvals ??= []);

state.polls ??= 0;
state.watchPolls ??= 0;

if (process.env.FAKE_GH_LOG) {
  appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`);
}

const polls = () => state.polls ?? 0;
const watchPolls = () => state.watchPolls ?? 0;
const now = () => new Date().toISOString();
const respond = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const refuse = (message: string) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};
const option = (name: string) => args[args.indexOf(name) + 1];
const values = (name: string) =>
  args.flatMap((argument, index) =>
    argument === name ? [args[index + 1] ?? ""] : [],
  );
const paginated = () => args.includes("--paginate");

function play(): void {
  for (const [label, request] of Object.entries(requests)) {
    const outcome = state.outcomes?.[label]?.[request.count - 1];
    const key = `${label}#${request.count}`;

    if (
      !outcome ||
      played.includes(key) ||
      polls() - request.atPoll < (outcome.afterPolls ?? 1)
    ) {
      continue;
    }

    played.push(key);

    const [service, rest = ""] = label.split("-review:");
    const kind = rest.split(":")[0];

    if (outcome.review) {
      state.reviews.push({
        id: 1000 + state.reviews.length,
        body: `${outcome.review.body ?? "Two findings."}\n\n<!-- ${service}-review kind=${kind} sha=${state.pr.headRefOid} run=01jexample -->`,
        html_url: `https://github.com/${state.repo}/pull/${state.pr.number}#pullrequestreview-${1000 + state.reviews.length}`,
        submitted_at: now(),
        state: "COMMENTED",
      });
      completeCheck(label, "neutral", "Posted, 2 findings");
    }

    if (outcome.refusal) {
      state.comments.push({
        id: 2000 + state.comments.length,
        body: `The service did not start a review for \`${label}\`: ${outcome.refusal}\n\n<!-- ${service}-review-refused request=9 -->`,
        html_url: `https://github.com/${state.repo}/pull/${state.pr.number}#issuecomment-${2000 + state.comments.length}`,
        created_at: now(),
      });
    }

    if (outcome.check) {
      completeCheck(label, outcome.check.conclusion, outcome.check.title);
    }

    if (outcome.headMovesTo) {
      state.pr.headRefOid = outcome.headMovesTo;
    }

    if (outcome.state) {
      state.pr.state = outcome.state;
    }

    state.pr.labels = state.pr.labels.filter(({ name }) => name !== label);
  }
}

function answerIssueLabels(method: string, path: string): void {
  if (method === "DELETE") {
    const label = decodeURIComponent(path.split("/labels/")[1] ?? "");

    state.pr.labels = state.pr.labels.filter(({ name }) => name !== label);

    return respond(state.pr.labels);
  }

  if (method === "POST") {
    for (const field of values("-f")) {
      const label = field.slice("labels[]=".length);

      state.pr.labels.push({ name: label });
      requests[label] = {
        count: (requests[label]?.count ?? 0) + 1,
        atPoll: polls(),
      };
    }

    return respond(state.pr.labels);
  }

  return respond([state.pr.labels]);
}

function completeCheck(label: string, conclusion: string, title: string): void {
  state.checkRuns.push({
    id: 3000 + state.checkRuns.length,
    name: label,
    head_sha: state.pr.headRefOid,
    status: "completed",
    conclusion,
    started_at: now(),
    output: { title },
  });
}

/**
 * The check run as the API would serve it at this poll, or null while
 * it has not registered.
 */
function visibleCheck(check: FakeCheck): ServedCheck | null {
  const poll = watchPolls();
  const served = (
    status: string,
    conclusion: string | null = null,
  ): ServedCheck => ({
    id: check.id,
    name: check.name,
    head_sha: check.head_sha,
    status,
    conclusion,
    started_at: check.started_at ?? now(),
    output: check.output ?? { title: null },
    app: {
      id: check.app_id ?? (check.run_id ? ACTIONS_APP_ID : 777),
      slug: check.run_id ? "github-actions" : "reviewbot",
    },
    html_url: check.run_id
      ? `https://github.com/${state.repo}/actions/runs/${check.run_id}/job/${check.id}`
      : null,
    details_url:
      check.details_url ?? `https://reviewbot.example/runs/${check.id}`,
  });

  if (check.status) {
    return served(check.status, check.conclusion ?? null);
  }

  if (poll < (check.appearsAtPoll ?? 1)) {
    return null;
  }

  if (check.gate) {
    const { gate } = check;
    const approval = approvals.find(
      (candidate) =>
        candidate.run_id === check.run_id &&
        candidate.environment_id === gate.environment.id,
    );

    if (approval) {
      return poll > approval.atPoll
        ? served("completed", "success")
        : served("in_progress");
    }

    if (poll < (gate.waitsAtPoll ?? 1)) {
      return served("queued");
    }

    const timerOnly = gate.reviewers?.length === 0;

    return timerOnly && poll >= (gate.endsAtPoll ?? 2)
      ? served("completed", "success")
      : served("waiting");
  }

  if (check.heldByGate) {
    const approval = approvals.find(
      (candidate) => candidate.run_id === check.run_id,
    );

    if (!approval) {
      return null;
    }

    return poll > approval.atPoll + 1
      ? served("completed", "success")
      : served("in_progress");
  }

  if (poll < (check.queuedUntil ?? 0)) {
    return served("queued");
  }

  return poll >= (check.completesAtPoll ?? 1)
    ? served("completed", check.conclusion ?? "success")
    : served("in_progress");
}

function visibleChecks(sha: string): ServedCheck[] {
  return state.checkRuns
    .map(visibleCheck)
    .filter(
      (check): check is ServedCheck => check !== null && check.head_sha === sha,
    );
}

function runIds(): number[] {
  return [
    ...new Set([
      ...state.checkRuns.flatMap(({ run_id }) => (run_id ? [run_id] : [])),
      ...Object.keys(state.runs ?? {}).map(Number),
    ]),
  ];
}

function runExists(runId: number): boolean {
  const run = state.runs?.[runId];

  return !run?.missing && watchPolls() >= (run?.appearsAtPoll ?? 0);
}

function runStatus(runId: number): string {
  const checks = state.checkRuns
    .filter((check) => check.run_id === runId)
    .map(visibleCheck);

  if (checks.some((check) => check?.status === "waiting")) {
    return "waiting";
  }

  return checks.every((check) => check?.status === "completed")
    ? "completed"
    : "in_progress";
}

function runDetails(runId: number) {
  const status = runStatus(runId);
  const run = state.runs?.[runId];
  const path = run?.path ?? ".github/workflows/ci.yml";
  const htmlUrl = `https://github.com/${state.repo}/actions/runs/${runId}`;
  // The run's conclusion follows its latest attempt of each job.
  const latest = new Map<string, ServedCheck>();

  for (const check of state.checkRuns.filter(
    (candidate) => candidate.run_id === runId,
  )) {
    const visible = visibleCheck(check);

    if (visible && (latest.get(check.name)?.id ?? 0) < visible.id) {
      latest.set(check.name, visible);
    }
  }

  const failed = [...latest.values()].some(
    (check) =>
      !["success", "neutral", "skipped"].includes(check.conclusion ?? ""),
  );

  // A run rerun between two reads still shows its old failure while its
  // jobs run again.
  if (run?.staleFailure && status !== "completed") {
    return {
      id: runId,
      status: "completed",
      conclusion: "failure",
      html_url: htmlUrl,
      path,
    };
  }

  return {
    id: runId,
    status,
    conclusion:
      status === "completed"
        ? (run?.conclusion ?? (failed ? "failure" : "success"))
        : null,
    html_url: htmlUrl,
    path,
  };
}

function pendingDeployments(runId: number) {
  const environments = new Map<number, unknown>();

  for (const check of state.checkRuns) {
    if (
      check.run_id !== runId ||
      !check.gate ||
      visibleCheck(check)?.status !== "waiting"
    ) {
      continue;
    }

    environments.set(check.gate.environment.id, {
      environment: check.gate.environment,
      wait_timer: check.gate.wait_timer ?? 0,
      wait_timer_started_at: null,
      current_user_can_approve: check.gate.can_approve ?? true,
      reviewers: check.gate.reviewers ?? DEFAULT_REVIEWERS,
    });
  }

  return [...environments.values()];
}

function answerPullRequest(): void {
  const poll = watchPolls();
  const head =
    state.pr.headMovesAtPoll !== undefined && poll >= state.pr.headMovesAtPoll
      ? state.pr.headMovesTo
      : state.pr.headRefOid;
  const prState =
    state.pr.closesAtPoll !== undefined && poll >= state.pr.closesAtPoll
      ? (state.pr.closesAs ?? "MERGED")
      : state.pr.state;

  return respond({
    state: prState === "OPEN" ? "open" : "closed",
    merged: prState === "MERGED",
    head: { sha: head },
    base: { ref: state.pr.base ?? "main" },
  });
}

function answerActionsRuns(method: string, path: string): void {
  if (path.includes("/actions/runs?")) {
    const sha = path.split("head_sha=")[1]?.split("&")[0];
    const runs = runIds()
      .filter(
        (runId) =>
          runExists(runId) &&
          (state.runs?.[runId] !== undefined ||
            state.checkRuns.some(
              (check) => check.run_id === runId && check.head_sha === sha,
            )),
      )
      .map(runDetails);

    return respond([{ total_count: runs.length, workflow_runs: runs }]);
  }

  const runId = Number(path.split("/actions/runs/")[1]?.split("/")[0]);

  if (path.endsWith("/pending_deployments")) {
    if (method === "POST") {
      if (state.runs?.[runId]?.refusesApproval) {
        return refuse("HTTP 422: The environment refused the approval");
      }

      for (const field of values("-F")) {
        if (!field.startsWith("environment_ids[]=")) {
          continue;
        }

        approvals.push({
          run_id: runId,
          environment_id: Number(field.slice("environment_ids[]=".length)),
          atPoll: watchPolls(),
        });
      }

      return respond([]);
    }

    return respond(pendingDeployments(runId));
  }

  if (!runExists(runId)) {
    return refuse("HTTP 404: Not Found");
  }

  return respond(runDetails(runId));
}

function commitOf(path: string): string {
  return path.split("/commits/")[1]?.split("/")[0] ?? "";
}

function answer(): void {
  const [command, subcommand] = args;

  // Claude Code on the web refuses GraphQL, which gh pr and gh repo call
  if (command === "pr" || command === "repo" || subcommand === "graphql") {
    return refuse("HTTP 403: GitHub GraphQL is not available");
  }

  const path = args.find((argument) => argument.startsWith("repos/"));

  if (command === "api" && path !== undefined) {
    const method = args.includes("-X") ? (option("-X") ?? "GET") : "GET";

    if (path === "repos/{owner}/{repo}") {
      return respond({ full_name: state.repo });
    }

    if (path.endsWith(`/pulls/${state.pr.number}`)) {
      return answerPullRequest();
    }

    if (path.includes("/issues/") && path.includes("/labels")) {
      return answerIssueLabels(method, path);
    }

    if (path.includes("/labels")) {
      return respond(state.labelPages ?? [state.labels]);
    }

    if (path.endsWith("/reviews")) {
      state.polls = polls() + 1;
      play();

      return respond([state.reviews]);
    }

    if (path.includes("/comments")) {
      return respond([state.comments]);
    }

    if (path.includes("/check-runs")) {
      const sha = commitOf(path);

      if (path.includes("check_name=")) {
        const name = decodeURIComponent(path.split("check_name=")[1] ?? "");

        return respond({
          check_runs: visibleChecks(sha).filter((check) => check.name === name),
        });
      }

      state.watchPolls = watchPolls() + 1;

      const checks = visibleChecks(sha);

      return respond([{ total_count: checks.length, check_runs: checks }]);
    }

    if (path.includes("/status")) {
      const sha = commitOf(path);
      const statuses = (state.statuses ?? []).filter(
        (status) => !status.sha || status.sha === sha,
      );
      const combined = { state: "pending", statuses };

      return respond(paginated() ? [combined] : combined);
    }

    if (path.includes("/rules/branches/")) {
      const rules = state.rules ?? [];

      return respond(paginated() ? [rules] : rules);
    }

    if (path.includes("/protection/required_status_checks")) {
      if (state.protection && "forbidden" in state.protection) {
        return refuse(
          "HTTP 403: Resource not accessible by personal access token",
        );
      }

      return state.protection
        ? respond(state.protection)
        : refuse("HTTP 404: Branch not protected");
    }

    if (path.includes("/actions/runs")) {
      return answerActionsRuns(method, path);
    }
  }

  refuse(`fake gh does not know: gh ${args.join(" ")}`);
}

const stallOn = process.env.FAKE_GH_STALL_ON;

if (stallOn && args.join(" ").includes(stallOn)) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

play();
answer();
writeFileSync(statePath, JSON.stringify(state, null, 2));
