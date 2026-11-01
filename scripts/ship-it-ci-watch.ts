#!/usr/bin/env bun
// Watches the checks of a pull request's head, or of a commit, until they end.

import {
  ScriptError,
  gh,
  ghList,
  ghRecord,
  isRecord,
  main,
  numberOrNull,
  parseArguments,
  parsePullRequestNumber,
  parseReviewLabel,
  positiveNumber,
  printJson,
  readPullRequest,
  records,
  requiredNumber,
  resolveRepository,
  sleep,
  stringOrNull,
} from "./lib";
import type { JsonRecord } from "./lib";

const USAGE = `Usage: ship-it-ci-watch.ts <pull request | commit> [options]

Watches the checks of a pull request's head, or of a commit, until they
end, and prints the outcome as JSON.

For a pull request, the watch covers the checks its merge requires, read
from the base branch's rulesets and branch protection: the required
status checks, and the jobs of the required workflows. When they name
none, it covers every check on the head except a review service's
(<service>-review:<kind>) and the manual gates. A job that waits for an
environment's reviewers is a manual gate: the watch never waits for one
unless the merge requires it, and lists each in "gates". A job that
waits for an environment's timer goes on by itself, so the watch waits.

For a commit, the watch covers every check except a review service's,
gates included, so a run that waits for a reviewer ends it as "gated".

--approve-gates approves each gate the user can approve, with the
environment's pending deployment, and keeps watching. With a value, it
approves the named environments only.

Results: passed, failed, gated, none (no check registered in time),
timeout, superseded (the head moved) and closed (the pull request closed).
When nothing at all appears on the head (no check, status or workflow
run) within --first-check, the result is none and the script exits 1.

Arguments:
  <pull request>   A number or a github.com pull request URL
  <commit>         A commit SHA of 7 to 40 hex digits

Options:
  --repo owner/name                 The repository (default: the URL's, or the current directory's)
  --timeout <minutes>               How long the watch waits in all (default: 45)
  --interval <seconds>              Time between reads (default: 30)
  --register <minutes>              How long the checks get to register while nothing runs (default: 2)
  --first-check <minutes>           How long a head with nothing on it waits for its first check or run (default: 5)
  --approve-gates[=<environment>,...]  Approve each manual gate the user can approve, or those of the named environments
`;

const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const ACTIONS_JOB_URL = /\/actions\/runs\/(\d+)(?:\/jobs?\/(\d+))?/;
const WORKFLOW_PATH = /(\.github\/workflows\/[^@]+)/;

// GitHub counts these as passing for a required check.
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

// A run that ends one of these ways before any job ran leaves no check
// run to say so.
const FAILED_RUN_CONCLUSIONS = new Set([
  "failure",
  "startup_failure",
  "timed_out",
  "action_required",
]);

type Result =
  | "passed"
  | "failed"
  | "gated"
  | "none"
  | "timeout"
  | "superseded"
  | "closed";

interface Check {
  id: number | null;
  source: "check_run" | "status";
  name: string;
  app_id: number | null;
  status: string | null;
  conclusion: string | null;
  url: string | null;
  run_id: number | null;
  job_id: number | null;
  workflow_path: string | null;
}

interface Run {
  id: number;
  status: string | null;
  conclusion: string | null;
  url: string | null;
  path: string | null;
}

interface Gate {
  run_id: number;
  url: string | null;
  environment: string;
  environment_id: number;
  can_approve: boolean;
  approved: boolean;
  approval_error?: string;
  jobs: string[];
}

interface RequiredContext {
  name: string;
  app_id: number | null;
}

interface Requirements {
  contexts: RequiredContext[];
  workflows: string[];
  known: boolean;
}

interface Ending {
  result: "superseded" | "closed";
  head_moved_to?: string;
  reason: string;
}

interface Subject {
  output: JsonRecord;
  /** How an approval comment names what the watch covers. */
  name: string;
  sha: string;
  required: Requirements;
  gatesHoldTheWatch: boolean;
  movedOrClosed?: () => Ending | null;
}

function isPassing(conclusion: string | null): boolean {
  return conclusion !== null && PASSING_CONCLUSIONS.has(conclusion);
}

function isReviewCheck({ name }: { name: string }): boolean {
  return parseReviewLabel(name) !== null;
}

class Watch {
  checks: Check[] = [];
  runs = new Map<number, Run>();
  gates = new Map<string, Gate>();
  runsWaitingForReviewers = new Set<number>();
  failedRuns: Run[] = [];
  suspectedFailedRunIds = new Set<number>();
  repository: string;
  subject: Subject;

  constructor(repository: string, subject: Subject) {
    this.repository = repository;
    this.subject = subject;
  }

  /**
   * Reads the commit's runs, its check runs and statuses, and the gates
   * of every run that waits for reviewers. The runs come first, since a
   * run exists before its first job registers a check.
   */
  read(): void {
    for (const run of listRuns(this.repository, this.subject.sha)) {
      this.runs.set(run.id, run);
    }

    const found = [
      ...checkRuns(this.repository, this.subject.sha),
      ...commitStatuses(this.repository, this.subject.sha),
    ];

    // A run the list leaves out (one a workflow outside the repository
    // started) is read on its own, once it is complete.
    for (const id of new Set(found.map(({ run_id }) => run_id))) {
      if (id && this.runs.get(id)?.status !== "completed") {
        this.runs.set(id, readRun(this.repository, id));
      }
    }

    for (const check of found) {
      check.workflow_path =
        check.run_id === null
          ? null
          : (this.runs.get(check.run_id)?.path ?? null);
    }

    this.checks = latestOfEach(found, checkKey);
    this.runsWaitingForReviewers = new Set();

    for (const run of this.runs.values()) {
      if (run.status !== "waiting") {
        continue;
      }

      for (const deployment of pendingDeployments(this.repository, run.id)) {
        // An environment with a timer and no reviewer goes on by itself.
        if (deployment.reviewers === 0) {
          continue;
        }

        const key = `${run.id}:${deployment.environment_id}`;
        const known = this.gates.get(key);

        this.runsWaitingForReviewers.add(run.id);
        this.gates.set(key, {
          run_id: run.id,
          url: run.url,
          environment: deployment.environment,
          environment_id: deployment.environment_id,
          can_approve: deployment.can_approve,
          approved: known?.approved ?? false,
          ...(known?.approval_error === undefined
            ? {}
            : { approval_error: known.approval_error }),
          jobs: this.checks
            .filter(
              (check) => check.run_id === run.id && check.status === "waiting",
            )
            .map(({ name }) => name),
        });
      }
    }

    // The runs and the checks are read apart, so a run rerun between the
    // two reads shows its old failure once: a failed run counts when two
    // reads in a row agree.
    const candidates = this.failedRunCandidates;

    this.failedRuns = candidates.filter((run) =>
      this.suspectedFailedRunIds.has(run.id),
    );
    this.suspectedFailedRunIds = new Set(candidates.map(({ id }) => id));
  }

  /**
   * Whether the head shows anything at all: a workflow run, or a check
   * or status that is not a review service's unless the merge requires it.
   */
  get anythingAppeared(): boolean {
    return (
      this.runs.size > 0 ||
      this.checks.some((check) => !isReviewCheck(check) || this.requires(check))
    );
  }

  /**
   * A gate waits for a reviewer. The jobs behind it register only once
   * it is approved, so a queued job is queued for a runner and runs.
   */
  isHeldByGate(check: Check): boolean {
    return (
      check.status === "waiting" &&
      check.run_id !== null &&
      this.runsWaitingForReviewers.has(check.run_id)
    );
  }

  /**
   * Whether the merge requires the check: by name, and by app when the
   * rule names one, or through the workflow it belongs to.
   */
  requires(check: Check): boolean {
    const { contexts, workflows } = this.subject.required;

    return (
      contexts.some((context) => answers(check, context)) ||
      (check.workflow_path !== null && workflows.includes(check.workflow_path))
    );
  }

  get requiresAny(): boolean {
    const { contexts, workflows } = this.subject.required;

    return contexts.length + workflows.length > 0;
  }

  /**
   * The checks the watch waits for: the required ones, or, when the
   * merge requires none, every check except a review service's and the
   * gates. A commit's watch keeps the gates.
   */
  get watched(): Check[] {
    if (this.requiresAny) {
      return this.checks.filter((check) => this.requires(check));
    }

    return this.checks.filter(
      (check) =>
        !isReviewCheck(check) &&
        (this.subject.gatesHoldTheWatch || !this.isHeldByGate(check)),
    );
  }

  /**
   * The runs still going whose jobs may yet register: a job's check run
   * appears once the job is queued, so a run with every known job done
   * can still hold one that needs them.
   */
  get openRuns(): Run[] {
    return [...this.runs.values()].filter(
      (run) =>
        run.status !== null &&
        run.status !== "completed" &&
        !this.runsWaitingForReviewers.has(run.id),
    );
  }

  /**
   * Whether the watch waits for the run: the required workflows' runs,
   * or every run when the merge requires nothing in particular, except
   * a run whose every job is a review service's.
   */
  isRunWatched(run: Run): boolean {
    if (this.requiresAny) {
      return (
        run.path !== null && this.subject.required.workflows.includes(run.path)
      );
    }

    const jobs = this.checks.filter((check) => check.run_id === run.id);

    return jobs.length === 0 || jobs.some((job) => !isReviewCheck(job));
  }

  get watchedRuns(): Run[] {
    return this.openRuns.filter((run) => this.isRunWatched(run));
  }

  /**
   * The required contexts and workflows no check answers for yet.
   */
  get missing(): string[] {
    const { contexts, workflows } = this.subject.required;

    return [
      ...contexts
        .filter(
          (context) => !this.checks.some((check) => answers(check, context)),
        )
        .map(({ name }) => name),
      ...workflows.filter(
        (path) => !this.checks.some((check) => check.workflow_path === path),
      ),
    ];
  }

  isRegistered(): boolean {
    return this.requiresAny
      ? this.missing.length === 0
      : this.checks.some((check) => !isReviewCheck(check));
  }

  /**
   * Whether anything still runs on its own, so a check that registers
   * once its dependencies finish may still come.
   */
  get anyRunning(): boolean {
    return (
      this.openRuns.length > 0 ||
      this.checks.some(
        (check) =>
          check.status !== "completed" &&
          !isReviewCheck(check) &&
          !this.isHeldByGate(check),
      )
    );
  }

  get passed(): Check[] {
    return this.watched.filter(
      (check) => check.status === "completed" && isPassing(check.conclusion),
    );
  }

  get failed(): Check[] {
    return this.watched.filter(
      (check) => check.status === "completed" && !isPassing(check.conclusion),
    );
  }

  /**
   * The watched runs that failed with no failed check to say so: a
   * workflow that failed before a job ran, or after its jobs passed. A
   * failed or running check of any job, a review service's included,
   * speaks for its run instead, and a run a newer run of the same
   * workflow replaced does not count.
   */
  get failedRunCandidates(): Run[] {
    const runs = [...this.runs.values()];
    const spokenFor = new Set(
      this.checks
        .filter(
          (check) =>
            check.status !== "completed" || !isPassing(check.conclusion),
        )
        .map(({ run_id }) => run_id),
    );

    return runs.filter(
      (run) =>
        run.status === "completed" &&
        run.conclusion !== null &&
        FAILED_RUN_CONCLUSIONS.has(run.conclusion) &&
        this.isRunWatched(run) &&
        !spokenFor.has(run.id) &&
        !runs.some((other) => other.path === run.path && other.id > run.id),
    );
  }

  get gatedWatched(): Check[] {
    return this.watched.filter((check) => this.isHeldByGate(check));
  }

  get pending(): Check[] {
    return this.watched.filter(
      (check) => check.status !== "completed" && !this.isHeldByGate(check),
    );
  }

  /**
   * Approves each gate the user can approve, all of them or those of the
   * named environments, and says how many it approved, so the next read
   * sees the run move on. A refusal stays on the gate, so the result
   * still names it.
   */
  approveGates(environments: string[] | null): number {
    let approved = 0;

    for (const gate of this.gates.values()) {
      if (
        gate.approved ||
        gate.approval_error ||
        !gate.can_approve ||
        (environments !== null && !environments.includes(gate.environment))
      ) {
        continue;
      }

      const refusal = attempt(() =>
        gh([
          "api",
          "-X",
          "POST",
          `repos/${this.repository}/actions/runs/${gate.run_id}/pending_deployments`,
          "-F",
          `environment_ids[]=${gate.environment_id}`,
          "-f",
          "state=approved",
          "-f",
          `comment=Approved by ship-it for ${this.subject.name}`,
        ]),
      );

      if (refusal instanceof ScriptError) {
        gate.approval_error = refusal.message;
        continue;
      }

      gate.approved = true;
      approved++;
    }

    return approved;
  }

  finish(result: Result, details: Partial<Ending> = {}): void {
    const { contexts, workflows } = this.subject.required;

    printJson({
      ...this.subject.output,
      result,
      ...details,
      required: [...contexts.map(({ name }) => name), ...workflows],
      watched: this.watched.map(({ name }) => name),
      passed: this.passed.map(({ name }) => name),
      failed: [
        ...this.failed.map(({ name, conclusion, url, run_id, job_id }) => ({
          name,
          conclusion,
          url,
          run_id,
          job_id,
        })),
        ...this.failedRuns.map(({ id, path, conclusion, url }) => ({
          name: path ?? `run ${id}`,
          conclusion,
          url,
          run_id: id,
          job_id: null,
        })),
      ],
      pending: [
        ...[...this.pending, ...this.gatedWatched].map(
          ({ name, status, url }) => ({ name, status, url }),
        ),
        ...this.watchedRuns.map(({ id, path, status, url }) => ({
          name: path ?? `run ${id}`,
          status,
          url,
        })),
      ],
      missing: this.missing,
      gates: [...this.gates.values()],
    });
  }
}

/**
 * Whether the check answers for a required context: by name, and by
 * app when the rule names one.
 */
function answers(check: Check, context: RequiredContext): boolean {
  return (
    context.name === check.name &&
    (context.app_id === null || context.app_id === check.app_id)
  );
}

await main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    valueFlags: ["repo", "timeout", "interval", "register", "first-check"],
    optionalValueFlags: ["approve-gates"],
  });
  const [target] = positionals;

  if (target === undefined || positionals.length > 1) {
    throw new ScriptError(
      `ship-it-ci-watch.ts needs one pull request or one commit.\n\n${USAGE}`,
    );
  }

  const repository = resolveRepository(flags.repo, target);
  const timeoutMs =
    positiveNumber(flags.timeout ?? 45, "timeout", USAGE) * 60_000;
  const intervalSeconds = positiveNumber(
    flags.interval ?? 30,
    "interval",
    USAGE,
  );
  const registerMs =
    positiveNumber(flags.register ?? 2, "register", USAGE) * 60_000;
  const firstCheckMs =
    positiveNumber(flags["first-check"] ?? 5, "first-check", USAGE) * 60_000;
  const approving = approvedEnvironments(flags["approve-gates"]);

  const subject = COMMIT_SHA.test(target)
    ? commitSubject(repository, target)
    : pullRequestSubject(repository, target);

  const watch = new Watch(repository, subject);
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  let registered = false;
  let appeared = false;
  let quietSince = startedAt;

  for (let poll = 0; ; poll++) {
    if (poll > 0) {
      // Each read waits for the last one: a poll, never a batch.
      // oxlint-disable-next-line no-await-in-loop
      await sleep(intervalSeconds);
    }

    const moved = subject.movedOrClosed?.();

    if (moved) {
      return watch.finish(moved.result, moved);
    }

    watch.read();

    if (approving !== undefined && watch.approveGates(approving) > 0) {
      continue;
    }

    // A failed required check needs a fix whether or not the rest registered.
    if (watch.failed.length > 0 || watch.failedRuns.length > 0) {
      return watch.finish("failed");
    }

    if (!registered) {
      registered = watch.isRegistered();
    }

    if (!appeared && watch.anythingAppeared) {
      appeared = true;
      // The registration window counts from the first sign of CI.
      quietSince = Date.now();
    }

    // Right after a push, the head can show nothing for a while: no run,
    // no check. Running out of that wait is an error, since a head CI
    // never reached is never a pass.
    if (!appeared && elapsed() >= Math.min(firstCheckMs, timeoutMs)) {
      watch.finish("none");

      throw new ScriptError(
        `Nothing appeared on ${subject.sha} within ${Math.round(elapsed() / 1000)} seconds: no check run, no commit status and no workflow run. Either CI never started for this head (check the workflows' triggers and the Actions tab), or the repository runs no CI on it.`,
      );
    }

    if (!appeared) {
      continue;
    }

    // A required job registers once its dependencies finish, so the
    // registration window counts from the last moment something ran.
    if (watch.anyRunning) {
      quietSince = Date.now();
    }

    if (!registered && Date.now() - quietSince >= registerMs) {
      return watch.finish("none");
    }

    // A run suspected of failing holds the watch until the next read agrees.
    if (
      registered &&
      watch.pending.length === 0 &&
      watch.watchedRuns.length === 0 &&
      watch.suspectedFailedRunIds.size === 0
    ) {
      return watch.finish(watch.gatedWatched.length > 0 ? "gated" : "passed");
    }

    if (elapsed() >= timeoutMs) {
      return watch.finish("timeout");
    }
  }
});

/**
 * The environments --approve-gates covers: undefined without the flag,
 * null for every environment, or the names given.
 */
function approvedEnvironments(
  flag: string | true | undefined,
): string[] | null | undefined {
  if (flag === undefined) {
    return undefined;
  }

  if (flag === true) {
    return null;
  }

  const names = flag
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (names.length === 0) {
    throw new ScriptError(
      `The --approve-gates option needs environment names, got "${flag}".\n\n${USAGE}`,
    );
  }

  return names;
}

function commitSubject(repository: string, sha: string): Subject {
  return {
    output: { repository, commit: sha },
    name: sha,
    sha,
    required: { contexts: [], workflows: [], known: true },
    gatesHoldTheWatch: true,
  };
}

function pullRequestSubject(repository: string, argument: string): Subject {
  const number = parsePullRequestNumber(argument);
  const pullRequest = readPullRequest(repository, number);

  if (pullRequest.state !== "open") {
    throw new ScriptError(
      `Pull request #${number} on ${repository} is ${pullRequest.state}. The watch covers an open pull request, or a commit.`,
    );
  }

  const required = requirements(repository, pullRequest.base);

  return {
    output: {
      repository,
      pull_request: number,
      head: pullRequest.head,
      ...(required.known ? {} : { requirements_known: false }),
    },
    name: `PR #${number}`,
    sha: pullRequest.head,
    required,
    // With the protection unread, a gate may be required: hold for it.
    gatesHoldTheWatch: !required.known,
    movedOrClosed() {
      const current = readPullRequest(repository, number);

      if (current.state !== "open") {
        return {
          result: "closed",
          reason: `The pull request is ${current.state}.`,
        };
      }

      if (current.head !== pullRequest.head) {
        return {
          result: "superseded",
          head_moved_to: current.head,
          reason: `The head moved to ${current.head}. Watch the new head.`,
        };
      }

      return null;
    },
  };
}

/**
 * What the branch's rulesets and its classic protection require: status
 * check contexts, each pinned to an app when the rule names one, and
 * workflows, by the path their runs report. Rulesets answer for any
 * branch, and include the ones an organization adds. Classic protection
 * answers 404 for a branch without it, which means nothing from it, and
 * 403 without admin access, which leaves the requirements unknown. Its
 * `checks` carry the app each context is pinned to, and `contexts`
 * repeat them without it.
 */
function requirements(repository: string, branch: string): Requirements {
  const encoded = encodeURIComponent(branch);
  const rules = records(
    ghList(`repos/${repository}/rules/branches/${encoded}?per_page=100`),
  );
  const protection = attempt(() =>
    ghRecord(
      `repos/${repository}/branches/${encoded}/protection/required_status_checks`,
    ),
  );
  const protectionRefused =
    protection instanceof ScriptError &&
    !protection.message.includes("HTTP 404");
  const protectedContexts = protectedStatusChecks(
    protection instanceof ScriptError ? {} : protection,
  );

  const ruleParameters = (type: string) =>
    rules
      .filter((rule) => rule.type === type)
      .map((rule) => (isRecord(rule.parameters) ? rule.parameters : {}));

  const contexts = [
    ...ruleParameters("required_status_checks")
      .flatMap((parameters) => records(parameters.required_status_checks))
      .map((check) => ({
        name: String(check.context),
        app_id: numberOrNull(check.integration_id),
      })),
    ...protectedContexts,
  ];
  const workflows = ruleParameters("workflows")
    .flatMap((parameters) => records(parameters.workflows))
    .map(({ path }) => workflowPath(stringOrNull(path)))
    .filter((path) => path !== null);

  return {
    contexts: latestOfEach(contexts, ({ name, app_id }) => `${name}:${app_id}`),
    workflows: [...new Set(workflows)],
    known: !protectionRefused,
  };
}

/**
 * The contexts classic protection requires: `checks` pins each to its
 * app, and the older `contexts` names them alone.
 */
function protectedStatusChecks(protection: JsonRecord): RequiredContext[] {
  if (Array.isArray(protection.checks)) {
    return records(protection.checks).map((check) => ({
      name: String(check.context),
      app_id: numberOrNull(check.app_id),
    }));
  }

  return (Array.isArray(protection.contexts) ? protection.contexts : [])
    .filter((name) => typeof name === "string")
    .map((name) => ({ name, app_id: null }));
}

/**
 * A workflow's file path, as rulesets name it: without the repository
 * a reference prefixes, or the ref a run suffixes (`...build.yml@main`).
 */
function workflowPath(path: string | null): string | null {
  return path?.match(WORKFLOW_PATH)?.[1] ?? path;
}

/**
 * The call's result, or the ScriptError a refused gh call raised, so a
 * caller can go on without it.
 */
function attempt<T>(call: () => T): T | ScriptError {
  try {
    return call();
  } catch (error) {
    if (error instanceof ScriptError) {
      return error;
    }

    throw error;
  }
}

function checkRuns(repository: string, sha: string): Check[] {
  return records(
    ghList(`repos/${repository}/commits/${sha}/check-runs?per_page=100`),
  )
    .flatMap((page) => records(page.check_runs))
    .map((run) => {
      const htmlUrl = stringOrNull(run.html_url);
      const [, runId, jobId] = htmlUrl?.match(ACTIONS_JOB_URL) ?? [];

      return {
        id: numberOrNull(run.id),
        source: "check_run",
        name: String(run.name),
        app_id: isRecord(run.app) ? numberOrNull(run.app.id) : null,
        status: stringOrNull(run.status),
        conclusion: stringOrNull(run.conclusion),
        url: htmlUrl ?? stringOrNull(run.details_url),
        run_id: runId ? Number(runId) : null,
        job_id: jobId ? Number(jobId) : null,
        workflow_path: null,
      };
    });
}

/**
 * Commit statuses, which services outside Actions still post. The
 * combined status holds the newest status per context.
 */
function commitStatuses(repository: string, sha: string): Check[] {
  return records(
    ghList(`repos/${repository}/commits/${sha}/status?per_page=100`),
  )
    .flatMap((page) => records(page.statuses))
    .map((status) => ({
      id: numberOrNull(status.id),
      source: "status",
      name: String(status.context),
      app_id: null,
      status: status.state === "pending" ? "in_progress" : "completed",
      conclusion:
        status.state === "pending" ? null : stringOrNull(status.state),
      url: stringOrNull(status.target_url),
      run_id: null,
      job_id: null,
      workflow_path: null,
    }));
}

/**
 * Jobs of one name in two workflows stay apart, as do a check run and a
 * commit status of one name, since the merge needs each of them.
 */
function checkKey({
  source,
  app_id,
  workflow_path,
  run_id,
  name,
}: Check): string {
  return `${source}:${app_id}:${workflow_path ?? run_id}:${name}`;
}

/**
 * One entry per key: the one with the highest id, since a re-run or a
 * later run of the same workflow adds a check run with a higher id.
 */
function latestOfEach<Item extends { name: string; id?: number | null }>(
  items: Item[],
  keyOf: (item: Item) => string,
): Item[] {
  const byKey = new Map<string, Item>();

  for (const item of items) {
    const key = keyOf(item);
    const known = byKey.get(key);

    if (!known || (item.id ?? 0) > (known.id ?? 0)) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Actions runs on the commit. A repository that refuses the list
 * leaves the runs to be read from the check runs.
 */
function listRuns(repository: string, sha: string): Run[] {
  const pages = attempt(() =>
    ghList(`repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`),
  );

  if (pages instanceof ScriptError) {
    return [];
  }

  return records(pages)
    .flatMap((page) => records(page.workflow_runs))
    .map((run) => runDetails(run, "actions/runs"));
}

/**
 * A run's state and workflow. A run the repository cannot serve (one a
 * workflow outside it started) reads as unknown, and its check runs
 * speak for it.
 */
function readRun(repository: string, id: number): Run {
  const path = `repos/${repository}/actions/runs/${id}`;
  const run = attempt(() => ghRecord(path));

  return run instanceof ScriptError
    ? { id, status: null, conclusion: null, url: null, path: null }
    : runDetails(run, path);
}

function runDetails(run: JsonRecord, source: string): Run {
  return {
    id: requiredNumber(run, "id", source),
    status: stringOrNull(run.status),
    conclusion: stringOrNull(run.conclusion),
    url: stringOrNull(run.html_url),
    path: workflowPath(stringOrNull(run.path)),
  };
}

interface PendingDeployment {
  environment: string;
  environment_id: number;
  can_approve: boolean;
  reviewers: number;
}

function pendingDeployments(
  repository: string,
  runId: number,
): PendingDeployment[] {
  const path = `repos/${repository}/actions/runs/${runId}/pending_deployments`;

  return records(gh(["api", path])).map((deployment) => {
    const environment = isRecord(deployment.environment)
      ? deployment.environment
      : {};

    return {
      environment: String(environment.name),
      environment_id: requiredNumber(environment, "id", path),
      can_approve: deployment.current_user_can_approve === true,
      reviewers: Array.isArray(deployment.reviewers)
        ? deployment.reviewers.length
        : 0,
    };
  });
}
