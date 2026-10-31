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
from the base branch's rulesets and branch protection. When they name
none, it covers every check on the head except a review service's
(<service>-review:<kind>) and the manual gates. A job that waits for an
environment's approval is a manual gate: the watch never waits for one
unless the merge requires it, and lists each in "gates".

For a commit, the watch covers every check except a review service's,
gates included, so a run that waits for an approval ends it as "gated".

--approve-gates approves each gate the user can approve, with the
environment's pending deployment, and keeps watching.

Results: passed, failed, gated, none (no check registered in time),
timeout, superseded (the head moved) and closed (the pull request closed).

Arguments:
  <pull request>   A number or a github.com pull request URL
  <commit>         A commit SHA of 7 to 40 hex digits

Options:
  --repo owner/name      The repository (default: the URL's, or the current directory's)
  --timeout <minutes>    How long the watch waits in all (default: 45)
  --interval <seconds>   Time between reads (default: 30)
  --register <minutes>   How long the checks get to register after a push (default: 2)
  --approve-gates        Approve each manual gate the user can approve
`;

const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const ACTIONS_JOB_URL = /\/actions\/runs\/(\d+)(?:\/jobs?\/(\d+))?/;

// GitHub counts these as passing for a required check.
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

class Watch {
  checks = [];
  runs = new Map();
  gates = new Map();

  constructor(repository, subject) {
    this.repository = repository;
    this.subject = subject;
  }

  /**
   * Reads the commit's check runs and statuses, one entry per name, and
   * the state of every run that still has a job open.
   */
  read() {
    this.checks = latestByName([
      ...checkRuns(this.repository, this.subject.sha),
      ...commitStatuses(this.repository, this.subject.sha),
    ]);

    const openRunIds = new Set(
      this.checks
        .filter((check) => check.status !== "completed" && check.run_id)
        .map((check) => check.run_id),
    );

    this.runs = new Map(
      [...openRunIds].map((id) => [id, readRun(this.repository, id)]),
    );

    for (const run of this.runs.values()) {
      if (run.status !== "waiting") {
        continue;
      }

      for (const deployment of pendingDeployments(this.repository, run.id)) {
        const key = `${run.id}:${deployment.environment.id}`;
        const known = this.gates.get(key);

        this.gates.set(key, {
          run_id: run.id,
          url: run.url,
          environment: deployment.environment.name,
          environment_id: deployment.environment.id,
          can_approve: deployment.current_user_can_approve,
          approved: known?.approved ?? false,
          jobs: this.jobsOfRun(run.id, "waiting"),
          blocked: this.jobsOfRun(run.id, "queued"),
        });
      }
    }
  }

  jobsOfRun(runId, status) {
    return this.checks
      .filter((check) => check.run_id === runId && check.status === status)
      .map(({ name }) => name);
  }

  /**
   * A gate waits for an approval. A queued job of a run that waits for
   * one cannot start until someone approves, so the gate holds it too.
   * A job already running ends on its own.
   */
  isHeldByGate(check) {
    return (
      (check.status === "waiting" || check.status === "queued") &&
      this.runs.get(check.run_id)?.status === "waiting"
    );
  }

  /**
   * The checks the watch waits for: the required ones, or, when the
   * merge requires none, every check except a review service's and the
   * ones a gate holds. A commit's watch keeps the gated ones.
   */
  get watched() {
    const { required, gatesHoldTheWatch } = this.subject;

    if (required.length > 0) {
      return this.checks.filter(({ name }) => required.includes(name));
    }

    return this.checks.filter(
      (check) =>
        !parseReviewLabel(check.name) &&
        (gatesHoldTheWatch || !this.isHeldByGate(check)),
    );
  }

  get missing() {
    const present = new Set(this.checks.map(({ name }) => name));

    return this.subject.required.filter((name) => !present.has(name));
  }

  isRegistered() {
    return this.subject.required.length > 0
      ? this.missing.length === 0
      : this.checks.length > 0;
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

  get gatedWatched() {
    return this.watched.filter((check) => this.isHeldByGate(check));
  }

  get pending() {
    return this.watched.filter(
      (check) => check.status !== "completed" && !this.isHeldByGate(check),
    );
  }

  /**
   * Approves each gate the user can approve, and says how many it
   * approved, so the next read sees the run move on.
   */
  approveGates() {
    let approved = 0;

    for (const gate of this.gates.values()) {
      if (gate.approved || !gate.can_approve) {
        continue;
      }

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
      ]);

      gate.approved = true;
      approved++;
    }

    return approved;
  }

  finish(result, details = {}) {
    printJson({
      ...this.subject.output,
      result,
      ...details,
      required: this.subject.required,
      watched: this.watched.map(({ name }) => name),
      passed: this.passed.map(({ name }) => name),
      failed: this.failed.map(({ name, conclusion, url, run_id, job_id }) => ({
        name,
        conclusion,
        url,
        run_id,
        job_id,
      })),
      pending: [...this.pending, ...this.gatedWatched].map(
        ({ name, status, url }) => ({ name, status, url }),
      ),
      missing: this.missing,
      gates: [...this.gates.values()],
    });
  }
}

main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    valueFlags: ["repo", "timeout", "interval", "register"],
    booleanFlags: ["approve-gates"],
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
  const approveGates = flags["approve-gates"] === true;

  const subject = COMMIT_SHA.test(target)
    ? commitSubject(repository, target)
    : pullRequestSubject(repository, target);

  const watch = new Watch(repository, subject);
  const startedAt = Date.now();
  let registered = false;

  for (;;) {
    const moved = subject.movedOrClosed?.(repository);

    if (moved) {
      return watch.finish(moved.result, moved);
    }

    watch.read();

    if (!registered) {
      registered = watch.isRegistered();

      if (!registered && Date.now() - startedAt >= registerMs) {
        return watch.finish("none");
      }

      if (!registered) {
        await sleep(intervalSeconds);
        continue;
      }
    }

    if (approveGates && watch.approveGates() > 0) {
      await sleep(intervalSeconds);
      continue;
    }

    if (watch.failed.length > 0) {
      return watch.finish("failed");
    }

    if (watch.pending.length === 0) {
      return watch.finish(watch.gatedWatched.length > 0 ? "gated" : "passed");
    }

    if (Date.now() - startedAt >= timeoutMs) {
      return watch.finish("timeout");
    }

    await sleep(intervalSeconds);
  }
});

function commitSubject(repository, sha) {
  return {
    output: { repository, commit: sha },
    sha,
    required: [],
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

  const required = requiredContexts(repository, pullRequest.base);

  return {
    output: { repository, pull_request: number, head: pullRequest.head },
    sha: pullRequest.head,
    required,
    gatesHoldTheWatch: false,
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
 * The status check contexts the branch's rulesets and its classic
 * protection require. Rulesets answer for any branch, and include the
 * ones an organization adds. Classic protection answers 404 for a
 * branch without it, and 403 without admin access, so a refusal
 * means no contexts from it.
 */
function requiredContexts(repository, branch) {
  const encoded = encodeURIComponent(branch);
  const rules = gh(["api", `repos/${repository}/rules/branches/${encoded}`]);
  const fromRulesets = rules
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map(({ context }) => context);

  const protection = attempt(() =>
    gh([
      "api",
      `repos/${repository}/branches/${encoded}/protection/required_status_checks`,
    ]),
  );
  const fromProtection = [
    ...(protection?.contexts ?? []),
    ...(protection?.checks ?? []).map(({ context }) => context),
  ];

  return [...new Set([...fromRulesets, ...fromProtection])];
}

function attempt(call) {
  try {
    return call();
  } catch (error) {
    if (error instanceof ScriptError) {
      return null;
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
        name: run.name,
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
  const combined = gh(["api", `repos/${repository}/commits/${sha}/status`]);

  return (combined.statuses ?? []).map((status) => ({
    id: status.id,
    name: status.context,
    status: status.state === "pending" ? "in_progress" : "completed",
    conclusion:
      status.state === "pending"
        ? null
        : status.state === "success"
          ? "success"
          : status.state,
    url: status.target_url,
    run_id: null,
    job_id: null,
  }));
}

/**
 * One entry per check name: the newest, by id, since a re-run or a
 * later workflow run adds a check run with a higher id.
 */
function latestByName(checks) {
  const byName = new Map();

  for (const check of checks) {
    const known = byName.get(check.name);

    if (!known || check.id > known.id) {
      byName.set(check.name, check);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readRun(repository, id) {
  const run = gh(["api", `repos/${repository}/actions/runs/${id}`]);

  return { id, status: run.status, url: run.html_url };
}

function pendingDeployments(repository, runId) {
  return gh([
    "api",
    `repos/${repository}/actions/runs/${runId}/pending_deployments`,
  ]);
}
