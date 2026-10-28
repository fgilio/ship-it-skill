#!/usr/bin/env node
// Stands in for the GitHub CLI: answers the calls the review scripts make from
// a state file, and plays each label's scripted outcome once it is requested.
//
// State (FAKE_GH_STATE, rewritten on every call):
//   repo, labels, pr { number, state, headRefOid, labels }, reviews, comments,
//   checkRuns, outcomes { <label>: [<outcome per request>] }
// An outcome shows up `afterPolls` review listings after its request, and holds
// one of: review {}, refusal "<reason>", check { conclusion, title },
// headMovesTo "<sha>", state "<pull request state>". labelPages, when set,
// replaces the one page of labels. FAKE_GH_STALL_ON stalls any call whose
// arguments contain it.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));

state.polls ??= 0;
state.requests ??= {};
state.played ??= [];

if (process.env.FAKE_GH_LOG) {
  appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`);
}

const now = () => new Date().toISOString();
const respond = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const option = (name) => args[args.indexOf(name) + 1];
const values = (name) =>
  args.flatMap((argument, index) =>
    argument === name ? [args[index + 1]] : [],
  );

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

function answer() {
  const [command, subcommand] = args;

  // Claude Code on the web refuses GraphQL, which gh pr and gh repo call
  if (command === "pr" || command === "repo" || subcommand === "graphql") {
    process.stderr.write("HTTP 403: GitHub GraphQL is not available\n");
    process.exitCode = 1;

    return;
  }

  if (command === "api") {
    const method = args.includes("-X") ? option("-X") : "GET";
    const path = args.find((argument) => argument.startsWith("repos/"));

    if (path === "repos/{owner}/{repo}") {
      return respond({ full_name: state.repo });
    }

    if (path.endsWith(`/pulls/${state.pr.number}`)) {
      return respond({
        state: state.pr.state === "OPEN" ? "open" : "closed",
        merged: state.pr.state === "MERGED",
        head: { sha: state.pr.headRefOid },
      });
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
      const name = decodeURIComponent(path.split("check_name=")[1]);
      const sha = path.split("/commits/")[1].split("/")[0];

      return respond({
        check_runs: state.checkRuns.filter(
          (check) => check.name === name && check.head_sha === sha,
        ),
      });
    }
  }

  process.stderr.write(`fake gh does not know: gh ${args.join(" ")}\n`);
  process.exitCode = 1;
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
