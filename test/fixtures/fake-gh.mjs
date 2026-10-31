#!/usr/bin/env node
// Stands in for the GitHub CLI: answers the calls the scripts make from a
// state file, and plays each scripted outcome at its poll.
//
// State (FAKE_GH_STATE, rewritten on every call):
//   repo, labels, pr { number, state, headRefOid, base, labels }, reviews,
//   comments, checkRuns, statuses, rules, protection, runs,
//   outcomes { <label>: [<outcome per request>] }
//
// Review outcomes: an outcome shows up `afterPolls` review listings after its
// request, and holds one of: review {}, refusal "<reason>", check
// { conclusion, title }, headMovesTo "<sha>", state "<pull request state>".
// labelPages, when set, replaces the one page of labels.
//
// CI watch: every listing of a commit's check runs without a name filter is
// one poll. A check run with a `status` is served as is. Without one, its
// status follows the poll count: hidden before `appearsAtPoll`, in progress
// before `completesAtPoll`, then completed with its `conclusion`. A check with
// `gate { environment, can_approve, reviewers, waitsAtPoll, endsAtPoll }`
// waits from `waitsAtPoll`: with reviewers, until its environment is approved,
// then it completes on the next poll; without reviewers (a timer), until
// `endsAtPoll`. A check with `heldByGate` stays queued until its run has an
// approval, then completes two polls later. `runs[<id>]` holds a run's
// workflow `path`, or `missing` for a run the repository cannot serve. A run
// is in progress while any of its checks has not registered. The pull
// request's head moves at `headMovesAtPoll` and the pull request closes at
// `closesAtPoll`.
//
// FAKE_GH_STALL_ON stalls any call whose arguments contain it.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));

state.polls ??= 0;
state.watchPolls ??= 0;
state.requests ??= {};
state.played ??= [];
state.approvals ??= [];

if (process.env.FAKE_GH_LOG) {
  appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`);
}

const ACTIONS_APP_ID = 15368;
const DEFAULT_REVIEWERS = [{ type: "Team", reviewer: { name: "Core Team" } }];

const now = () => new Date().toISOString();
const respond = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const refuse = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};
const option = (name) => args[args.indexOf(name) + 1];
const values = (name) =>
  args.flatMap((argument, index) =>
    argument === name ? [args[index + 1]] : [],
  );
const paginated = () => args.includes("--paginate");

function play() {
  for (const [label, request] of Object.entries(state.requests)) {
    const outcome = state.outcomes?.[label]?.[request.count - 1];
    const key = `${label}#${request.count}`;

    if (
      !outcome ||
      state.played.includes(key) ||
      state.polls - request.atPoll < (outcome.afterPolls ?? 1)
    ) {
      continue;
    }

    state.played.push(key);

    const [service, rest] = label.split("-review:");
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

function answerIssueLabels(method, path) {
  if (method === "DELETE") {
    const label = decodeURIComponent(path.split("/labels/")[1]);

    state.pr.labels = state.pr.labels.filter(({ name }) => name !== label);

    return respond(state.pr.labels);
  }

  if (method === "POST") {
    for (const field of values("-f")) {
      const label = field.slice("labels[]=".length);

      state.pr.labels.push({ name: label });
      state.requests[label] = {
        count: (state.requests[label]?.count ?? 0) + 1,
        atPoll: state.polls,
      };
    }

    return respond(state.pr.labels);
  }

  return respond([state.pr.labels]);
}

function completeCheck(label, conclusion, title) {
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
function visibleCheck(check) {
  const poll = state.watchPolls;
  const served = (status, conclusion = null) => ({
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
    const approval = state.approvals.find(
      (approval) =>
        approval.run_id === check.run_id &&
        approval.environment_id === check.gate.environment.id,
    );

    if (approval) {
      return poll > approval.atPoll
        ? served("completed", "success")
        : served("in_progress");
    }

    if (poll < (check.gate.waitsAtPoll ?? 1)) {
      return served("queued");
    }

    const timerOnly = check.gate.reviewers?.length === 0;

    return timerOnly && poll >= (check.gate.endsAtPoll ?? 2)
      ? served("completed", "success")
      : served("waiting");
  }

  if (check.heldByGate) {
    const approval = state.approvals.find(
      (approval) => approval.run_id === check.run_id,
    );

    if (!approval) {
      return served("queued");
    }

    return poll > approval.atPoll + 1
      ? served("completed", "success")
      : served("in_progress");
  }

  return poll >= (check.completesAtPoll ?? 1)
    ? served("completed", check.conclusion ?? "success")
    : served("in_progress");
}

function visibleChecks(sha) {
  return state.checkRuns
    .map(visibleCheck)
    .filter((check) => check && check.head_sha === sha);
}

function runStatus(runId) {
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

function pendingDeployments(runId) {
  const environments = new Map();

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

function answerPullRequest() {
  const poll = state.watchPolls;
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

function answerActionsRun(method, path) {
  const runId = Number(path.split("/actions/runs/")[1].split("/")[0]);

  if (path.endsWith("/pending_deployments")) {
    if (method === "POST") {
      for (const field of values("-F")) {
        if (!field.startsWith("environment_ids[]=")) {
          continue;
        }

        state.approvals.push({
          run_id: runId,
          environment_id: Number(field.slice("environment_ids[]=".length)),
          atPoll: state.watchPolls,
        });
      }

      return respond([]);
    }

    return respond(pendingDeployments(runId));
  }

  if (state.runs?.[runId]?.missing) {
    return refuse("HTTP 404: Not Found");
  }

  return respond({
    id: runId,
    status: runStatus(runId),
    html_url: `https://github.com/${state.repo}/actions/runs/${runId}`,
    path: state.runs?.[runId]?.path ?? ".github/workflows/ci.yml",
  });
}

function answer() {
  const [command, subcommand] = args;

  // Claude Code on the web refuses GraphQL, which gh pr and gh repo call
  if (command === "pr" || command === "repo" || subcommand === "graphql") {
    return refuse("HTTP 403: GitHub GraphQL is not available");
  }

  if (command === "api") {
    const method = args.includes("-X") ? option("-X") : "GET";
    const path = args.find((argument) => argument.startsWith("repos/"));

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
      state.polls++;
      play();

      return respond([state.reviews]);
    }

    if (path.includes("/comments")) {
      return respond([state.comments]);
    }

    if (path.includes("/check-runs")) {
      const sha = path.split("/commits/")[1].split("/")[0];

      if (path.includes("check_name=")) {
        const name = decodeURIComponent(path.split("check_name=")[1]);

        return respond({
          check_runs: visibleChecks(sha).filter((check) => check.name === name),
        });
      }

      state.watchPolls++;

      const checks = visibleChecks(sha);

      return respond([{ total_count: checks.length, check_runs: checks }]);
    }

    if (path.includes("/status")) {
      const sha = path.split("/commits/")[1].split("/")[0];
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
      return state.protection
        ? respond(state.protection)
        : refuse("HTTP 404: Branch not protected");
    }

    if (path.includes("/actions/runs/")) {
      return answerActionsRun(method, path);
    }
  }

  refuse(`fake gh does not know: gh ${args.join(" ")}`);
}

if (
  process.env.FAKE_GH_STALL_ON &&
  args.join(" ").includes(process.env.FAKE_GH_STALL_ON)
) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

play();
answer();
writeFileSync(statePath, JSON.stringify(state, null, 2));
