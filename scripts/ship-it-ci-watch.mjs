#!/usr/bin/env node
// Watches the checks of a pull request's head, or of a commit, until they end.

import {
  ScriptError,
  gh,
  ghList,
  main,
  parseArguments,
  parsePullRequestNumber,
  parseReviewLabel,
  positiveNumber,
  printJson,
  resolveRepository,
  sleep,
} from "./lib.mjs";

const USAGE = `Usage: ship-it-ci-watch.mjs <pull request | commit> [options]

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

Arguments:
  <pull request>   A number or a github.com pull request URL
  <commit>         A commit SHA of 7 to 40 hex digits

Options:
  --repo owner/name                 The repository (default: the URL's, or the current directory's)
  --timeout <minutes>               How long the watch waits in all (default: 45)
  --interval <seconds>              Time between reads (default: 30)
  --register <minutes>              How long the checks get to register while nothing runs (default: 2)
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

class Watch {
  checks = [];
  runs = new Map();
  gates = new Map();
  runsWaitingForReviewers = new Set();

  constructor(repository, subject) {
    this.repository = repository;
    this.subject = subject;
  }

  /**
   * Reads the commit's runs, its check runs and statuses, and the gates
   * of every run that waits for reviewers. The runs come first, since a
   * run exists before its first job registers a check.
   */
  read() {
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
      check.workflow_path = this.runs.get(check.run_id)?.path ?? null;
    }

    this.checks = latestOfEach(found);
    this.runsWaitingForReviewers = new Set();

    for (const run of this.runs.values()) {
      if (run.status !== "waiting") {
        continue;
      }

      for (const deployment of pendingDeployments(this.repository, run.id)) {
        // An environment with a timer and no reviewer goes on by itself.
        if ((deployment.reviewers ?? []).length === 0) {
          continue;
        }

        const key = `${run.id}:${deployment.environment.id}`;
        const known = this.gates.get(key);

        this.runsWaitingForReviewers.add(run.id);
        this.gates.set(key, {
          run_id: run.id,
          url: run.url,
          environment: deployment.environment.name,
          environment_id: deployment.environment.id,
          can_approve: deployment.current_user_can_approve,
          approved: known?.approved ?? false,
          ...(known?.approval_error && {
            approval_error: known.approval_error,
          }),
          jobs: this.checks
            .filter(
              (check) => check.run_id === run.id && check.status === "waiting",
            )
            .map(({ name }) => name),
        });
      }
    }
  }

  /**
   * A gate waits for a reviewer. The jobs behind it register only once
   * it is approved, so a queued job is queued for a runner and runs.
   */
  isHeldByGate(check) {
    return (
      check.status === "waiting" &&
      this.runsWaitingForReviewers.has(check.run_id)
    );
  }

  /**
   * Whether the merge requires the check: by name, and by app when the
   * rule names one, or through the workflow it belongs to.
   */
  requires(check) {
    const { contexts, workflows } = this.subject.required;

    return (
      contexts.some(
        (context) =>
          context.name === check.name &&
          (context.app_id === null || context.app_id === check.app_id),
      ) ||
      (check.workflow_path !== null && workflows.includes(check.workflow_path))
    );
  }

  get requiresAny() {
    const { contexts, workflows } = this.subject.required;

    return contexts.length + workflows.length > 0;
  }

  /**
   * The checks the watch waits for: the required ones, or, when the
   * merge requires none, every check except a review service's and the
   * gates. A commit's watch keeps the gates.
   */
  get watched() {
    if (this.requiresAny) {
      return this.checks.filter((check) => this.requires(check));
    }

    return this.checks.filter(
      (check) =>
        !parseReviewLabel(check.name) &&
        (this.subject.gatesHoldTheWatch || !this.isHeldByGate(check)),
    );
  }

  /**
   * The runs still going whose jobs may yet register: a job's check run
   * appears once the job is queued, so a run with every known job done
   * can still hold one that needs them.
   */
  get openRuns() {
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
  isRunWatched(run) {
    if (this.requiresAny) {
      return this.subject.required.workflows.includes(run.path);
    }

    const jobs = this.checks.filter((check) => check.run_id === run.id);

    return jobs.length === 0 || jobs.some((job) => !parseReviewLabel(job.name));
  }

  get watchedRuns() {
    return this.openRuns.filter((run) => this.isRunWatched(run));
  }

  /**
   * The required contexts and workflows no check answers for yet.
   */
  get missing() {
    const { contexts, workflows } = this.subject.required;

    return [
      ...contexts
        .filter(
          (context) =>
            !this.checks.some(
              (check) =>
                check.name === context.name &&
                (context.app_id === null || context.app_id === check.app_id),
            ),
        )
        .map(({ name }) => name),
      ...workflows.filter(
        (path) => !this.checks.some((check) => check.workflow_path === path),
      ),
    ];
  }

  isRegistered() {
    return this.requiresAny
      ? this.missing.length === 0
      : this.checks.some((check) => !parseReviewLabel(check.name));
  }

  /**
   * Whether anything still runs on its own, so a check that registers
   * once its dependencies finish may still come.
   */
  get anyRunning() {
    return (
      this.openRuns.length > 0 ||
      this.checks.some(
        (check) =>
          check.status !== "completed" &&
          !parseReviewLabel(check.name) &&
          !this.isHeldByGate(check),
      )
    );
  }

  get passed() {
    return this.watched.filter(
      (check) =>
        check.status === "completed" &&
        PASSING_CONCLUSIONS.has(check.conclusion),
    );
  }

  get failed() {
    return this.watched.filter(
      (check) =>
        check.status === "completed" &&
        !PASSING_CONCLUSIONS.has(check.conclusion),
    );
  }

  /**
   * The watched runs that failed with no failed check to say so: a
   * workflow that failed before a job ran, or after its jobs passed. A
   * run a newer run of the same workflow replaced no longer counts.
   */
  get failedRuns() {
    const runs = [...this.runs.values()];
    const failedRunIds = new Set(this.failed.map(({ run_id }) => run_id));

    return runs.filter(
      (run) =>
        run.status === "completed" &&
        FAILED_RUN_CONCLUSIONS.has(run.conclusion) &&
        this.isRunWatched(run) &&
        !failedRunIds.has(run.id) &&
        !runs.some((other) => other.path === run.path && other.id > run.id),
    );
  }

  get gatedWatched() {
    return this.watched.filter((check) => this.isHeldByGate(check));
  }

  get pending() {
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
  approveGates(environments) {
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
          `comment=Approved by ship-it for ${this.subject.output.pull_request ? `PR #${this.subject.output.pull_request}` : this.subject.sha}`,
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

  finish(result, details = {}) {
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

main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    valueFlags: ["repo", "timeout", "interval", "register"],
    optionalValueFlags: ["approve-gates"],
  });
  const [target] = positionals;

  if (target === undefined || positionals.length > 1) {
    throw new ScriptError(
      `ship-it-ci-watch.mjs needs one pull request or one commit.\n\n${USAGE}`,
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
  const approving = approvedEnvironments(flags["approve-gates"]);

  const subject = COMMIT_SHA.test(target)
    ? commitSubject(repository, target)
    : pullRequestSubject(repository, target);

  const watch = new Watch(repository, subject);
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  let registered = false;
  let quietSince = startedAt;

  for (;;) {
    const moved = subject.movedOrClosed?.(repository);

    if (moved) {
      return watch.finish(moved.result, moved);
    }

    watch.read();

    if (approving !== undefined && watch.approveGates(approving) > 0) {
      await sleep(intervalSeconds);
      continue;
    }

    // A failed required check needs a fix whether or not the rest registered.
    if (watch.failed.length > 0 || watch.failedRuns.length > 0) {
      return watch.finish("failed");
    }

    if (!registered) {
      registered = watch.isRegistered();
    }

    // A required job registers once its dependencies finish, so the
    // registration window counts from the last moment something ran.
    if (watch.anyRunning) {
      quietSince = Date.now();
    }

    if (!registered && Date.now() - quietSince >= registerMs) {
      return watch.finish("none");
    }

    if (
      registered &&
      watch.pending.length === 0 &&
      watch.watchedRuns.length === 0
    ) {
      return watch.finish(watch.gatedWatched.length > 0 ? "gated" : "passed");
    }

    if (elapsed() >= timeoutMs) {
      return watch.finish("timeout");
    }

    await sleep(intervalSeconds);
  }
});

/**
 * The environments --approve-gates covers: undefined without the flag,
 * null for every environment, or the names given.
 */
function approvedEnvironments(flag) {
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

function commitSubject(repository, sha) {
  return {
    output: { repository, commit: sha },
    sha,
    required: { contexts: [], workflows: [], known: true },
    gatesHoldTheWatch: true,
  };
}

function pullRequestSubject(repository, argument) {
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
      ...(required.known || { requirements_known: false }),
    },
    sha: pullRequest.head,
    required,
    // With the protection unread, a gate may be required: hold for it.
    gatesHoldTheWatch: !required.known,
    movedOrClosed(repository) {
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
 * The pull request's state (`open`, `closed` or `merged`), head commit
 * and base branch.
 */
function readPullRequest(repository, number) {
  const pullRequest = gh(["api", `repos/${repository}/pulls/${number}`]);

  return {
    state: pullRequest.merged ? "merged" : pullRequest.state,
    head: pullRequest.head.sha,
    base: pullRequest.base.ref,
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
function requirements(repository, branch) {
  const encoded = encodeURIComponent(branch);
  const rules = ghList(
    `repos/${repository}/rules/branches/${encoded}?per_page=100`,
  );
  const protection = attempt(() =>
    gh([
      "api",
      `repos/${repository}/branches/${encoded}/protection/required_status_checks`,
    ]),
  );
  const protectionRefused =
    protection instanceof ScriptError && !/HTTP 404/.test(protection.message);
  const protectedContexts = protection?.checks
    ? protection.checks.map(({ context, app_id }) => ({
        name: context,
        app_id: app_id ?? null,
      }))
    : (protection?.contexts ?? []).map((name) => ({ name, app_id: null }));

  const contexts = [
    ...rules
      .filter((rule) => rule.type === "required_status_checks")
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map(({ context, integration_id }) => ({
        name: context,
        app_id: integration_id ?? null,
      })),
    ...protectedContexts,
  ];
  const workflows = rules
    .filter((rule) => rule.type === "workflows")
    .flatMap((rule) => rule.parameters?.workflows ?? [])
    .map(({ path }) => workflowPath(path));

  return {
    contexts: latestOfEach(contexts, ({ name, app_id }) => `${name}:${app_id}`),
    workflows: [...new Set(workflows)],
    known: !protectionRefused,
  };
}

/**
 * A workflow's file path, as rulesets name it: without the repository
 * a reference prefixes, or the ref a run suffixes (`...build.yml@main`).
 */
function workflowPath(path) {
  return path?.match(WORKFLOW_PATH)?.[1] ?? path ?? null;
}

/**
 * The call's result, or the ScriptError a refused gh call raised, so a
 * caller can go on without it.
 */
function attempt(call) {
  try {
    return call();
  } catch (error) {
    if (error instanceof ScriptError) {
      return error;
    }

    throw error;
  }
}

function checkRuns(repository, sha) {
  return ghList(`repos/${repository}/commits/${sha}/check-runs?per_page=100`)
    .flatMap((page) => page.check_runs ?? [])
    .map((run) => {
      const [, runId, jobId] = run.html_url?.match(ACTIONS_JOB_URL) ?? [];

      return {
        id: run.id,
        source: "check_run",
        name: run.name,
        app_id: run.app?.id ?? null,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url ?? run.details_url,
        run_id: runId ? Number(runId) : null,
        job_id: jobId ? Number(jobId) : null,
      };
    });
}

/**
 * Commit statuses, which services outside Actions still post. The
 * combined status holds the newest status per context.
 */
function commitStatuses(repository, sha) {
  return ghList(`repos/${repository}/commits/${sha}/status?per_page=100`)
    .flatMap((page) => page.statuses ?? [])
    .map((status) => ({
      id: status.id,
      source: "status",
      name: status.context,
      app_id: null,
      status: status.state === "pending" ? "in_progress" : "completed",
      conclusion: status.state === "pending" ? null : status.state,
      url: status.target_url,
      run_id: null,
      job_id: null,
    }));
}

/**
 * One entry per key: the one with the highest id, since a re-run or a
 * later run of the same workflow adds a check run with a higher id.
 * Jobs of one name in two workflows stay apart, as do a check run and a
 * commit status of one name, since the merge needs each of them.
 */
function latestOfEach(
  items,
  keyOf = ({ source, app_id, workflow_path, run_id, name }) =>
    `${source}:${app_id}:${workflow_path ?? run_id}:${name}`,
) {
  const byKey = new Map();

  for (const item of items) {
    const key = keyOf(item);
    const known = byKey.get(key);

    if (!known || (item.id ?? 0) > (known.id ?? 0)) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Actions runs on the commit. A repository that refuses the list
 * leaves the runs to be read from the check runs.
 */
function listRuns(repository, sha) {
  const pages = attempt(() =>
    ghList(`repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`),
  );

  if (pages instanceof ScriptError) {
    return [];
  }

  return pages.flatMap((page) => page.workflow_runs ?? []).map(runDetails);
}

/**
 * A run's state and workflow. A run the repository cannot serve (one a
 * workflow outside it started) reads as unknown, and its check runs
 * speak for it.
 */
function readRun(repository, id) {
  const run = attempt(() =>
    gh(["api", `repos/${repository}/actions/runs/${id}`]),
  );

  return run instanceof ScriptError
    ? { id, status: null, conclusion: null, url: null, path: null }
    : runDetails(run);
}

function runDetails(run) {
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion ?? null,
    url: run.html_url,
    path: workflowPath(run.path),
  };
}

function pendingDeployments(repository, runId) {
  return gh([
    "api",
    `repos/${repository}/actions/runs/${runId}/pending_deployments`,
  ]);
}
