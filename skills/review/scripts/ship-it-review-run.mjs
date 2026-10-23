#!/usr/bin/env node
// Requests reviews through their labels and waits until each one answers.

import {
  ReviewError,
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

const USAGE = `Usage: ship-it-review-run.mjs <pull request> <label>... [options]

Requests a review for each label on the pull request's head commit, then
waits until each review posted, was refused, ended without a review, or
ran out of time. A request that ended without a review or ran out of time
is made again, up to --retries times. A review that already posted on the
head is reported without a new request. Prints the outcome as JSON.

Arguments:
  <pull request>   A number or a github.com pull request URL
  <label>          A review label, as ship-it-review-list.mjs prints it

Options:
  --repo owner/name     The repository (default: the URL's, or the current directory's)
  --timeout <minutes>   How long each request waits for an answer (default: 30)
  --interval <seconds>  Time between checks (default: 30)
  --retries <count>     Requests made again after no review or a timeout (default: 1)
`;

// GitHub's timestamps and this machine's clock can disagree by a little,
// so the comment listing starts this much before the earliest request.
const CLOCK_SKEW_MS = 2 * 60 * 1000;

main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    valueFlags: ["repo", "timeout", "interval", "retries"],
  });
  const [pullRequestArgument, ...labelNames] = positionals;

  if (pullRequestArgument === undefined || labelNames.length === 0) {
    throw new ReviewError(
      `ship-it-review-run.mjs needs a pull request and at least one label.\n\n${USAGE}`,
    );
  }

  const repository = resolveRepository(flags.repo, pullRequestArgument);
  const number = String(parsePullRequestNumber(pullRequestArgument));
  const timeoutMs =
    positiveNumber(flags.timeout ?? 30, "timeout", USAGE) * 60 * 1000;
  const intervalSeconds = positiveNumber(
    flags.interval ?? 30,
    "interval",
    USAGE,
  );
  const retries = retryCount(flags.retries ?? "1");

  // A finished check with no review yet may only mean the review posts a moment later.
  const graceMs = 2 * intervalSeconds * 1000;

  const head = openHead(repository, number);
  const requests = reviewRequests(repository, labelNames);
  const settled = [];

  const settle = (request, status, details = {}) => {
    Object.assign(request, { status }, details);
    settled.push(request);
  };

  const postedReviews = ghList(`repos/${repository}/pulls/${number}/reviews`);

  for (const request of requests) {
    const review = markedReview(postedReviews, request, head);

    if (review) {
      settle(request, "posted", reviewDetails(review));
    }
  }

  let pending = requests.filter((request) => !settled.includes(request));

  requestReviews(repository, number, head, pending);

  while (pending.length > 0) {
    await sleep(intervalSeconds);

    const pullRequest = gh([
      "pr",
      "view",
      number,
      "--repo",
      repository,
      "--json",
      "state,headRefOid",
    ]);

    if (pullRequest.state !== "OPEN") {
      pending.forEach((request) =>
        settle(request, "closed", {
          reason: `The pull request is ${pullRequest.state.toLowerCase()}.`,
        }),
      );
      break;
    }

    if (pullRequest.headRefOid !== head) {
      pending.forEach((request) =>
        settle(request, "superseded", {
          reason: `The head moved to ${pullRequest.headRefOid}. Request the review again for the new head.`,
        }),
      );
      break;
    }

    const earliestRequest = Math.min(
      ...pending.map((request) => request.requestedAt),
    );
    const reviews = ghList(`repos/${repository}/pulls/${number}/reviews`);
    const comments = ghList(
      `repos/${repository}/issues/${number}/comments?since=${new Date(earliestRequest - CLOCK_SKEW_MS).toISOString()}`,
    );
    const again = [];

    const endAttempt = (request, status, reason) => {
      if (request.attempts <= retries) {
        again.push(request);

        return;
      }

      settle(request, status, reason ? { reason } : {});
    };

    for (const request of pending) {
      const review = markedReview(reviews, request, head);

      if (review) {
        settle(request, "posted", reviewDetails(review));
        continue;
      }

      const refusal = refusalComment(comments, request);

      if (refusal) {
        settle(request, "refused", {
          reason: refusal.body.split("\n")[0].trim(),
          refusal_url: refusal.html_url,
        });
        continue;
      }

      const check = latestCheckRun(repository, head, request);

      if (check?.status === "completed") {
        request.completedSeenAt ??= Date.now();

        if (Date.now() - request.completedSeenAt >= graceMs) {
          endAttempt(
            request,
            "unanswered",
            check.output?.title || check.conclusion,
          );
        }

        continue;
      }

      if (Date.now() - request.requestedAt >= timeoutMs) {
        endAttempt(request, "timeout");
      }
    }

    pending = pending.filter((request) => !settled.includes(request));
    requestReviews(repository, number, head, again);
  }

  // A review can post for the requested head just as a push moves it.
  const { headRefOid: currentHead } = gh([
    "pr",
    "view",
    number,
    "--repo",
    repository,
    "--json",
    "headRefOid",
  ]);

  printJson({
    repository,
    pull_request: Number(number),
    head,
    head_moved_to: currentHead === head ? null : currentHead,
    reviews: requests.map(
      ({
        requestedAt,
        completedSeenAt,
        knownCommentIds,
        knownCheckIds,
        ...request
      }) => request,
    ),
  });
});

function retryCount(value) {
  const count = Number(value);

  if (!Number.isInteger(count) || count < 0) {
    throw new ReviewError(
      `The --retries option needs a whole number of 0 or more, got "${value}".\n\n${USAGE}`,
    );
  }

  return count;
}

function openHead(repository, number) {
  const pullRequest = gh([
    "pr",
    "view",
    number,
    "--repo",
    repository,
    "--json",
    "state,headRefOid",
  ]);

  if (pullRequest.state !== "OPEN") {
    throw new ReviewError(
      `Pull request #${number} on ${repository} is ${pullRequest.state.toLowerCase()}. Reviews run only on an open pull request.`,
    );
  }

  return pullRequest.headRefOid;
}

function reviewRequests(repository, labelNames) {
  const existing = new Set(
    ghList(`repos/${repository}/labels?per_page=100`).map(({ name }) => name),
  );

  return [...new Set(labelNames)].map((label) => {
    const parsed = parseReviewLabel(label);

    if (!parsed) {
      throw new ReviewError(
        `${label} is not a review label. A review label looks like <service>-review:<kind>.`,
      );
    }

    if (!existing.has(label)) {
      throw new ReviewError(
        `The label ${label} does not exist on ${repository}. ship-it-review-list.mjs lists the review labels it offers.`,
      );
    }

    return {
      label,
      service: parsed.service,
      kind: parsed.kind,
      status: "pending",
      attempts: 0,
    };
  });
}

/**
 * Adds the labels in one edit. A label still on the pull request asks
 * for nothing when added again, so it comes off first. The comments and
 * checks that exist before the edit belong to earlier requests, so the
 * wait never takes them for this request's answer.
 */
function requestReviews(repository, number, head, requests) {
  if (requests.length === 0) {
    return;
  }

  const knownCommentIds = new Set(
    ghList(`repos/${repository}/issues/${number}/comments`).map(({ id }) => id),
  );

  for (const request of requests) {
    request.knownCommentIds = knownCommentIds;
    request.knownCheckIds = new Set(
      checkRuns(repository, head, request.label).map(({ id }) => id),
    );
  }

  const onPullRequest = new Set(
    gh([
      "pr",
      "view",
      number,
      "--repo",
      repository,
      "--json",
      "labels",
    ]).labels.map(({ name }) => name),
  );
  const stale = requests.filter(({ label }) => onPullRequest.has(label));

  if (stale.length > 0) {
    gh(
      [
        "pr",
        "edit",
        number,
        "--repo",
        repository,
        ...stale.flatMap(({ label }) => ["--remove-label", label]),
      ],
      { json: false },
    );
  }

  gh(
    [
      "pr",
      "edit",
      number,
      "--repo",
      repository,
      ...requests.flatMap(({ label }) => ["--add-label", label]),
    ],
    { json: false },
  );

  for (const request of requests) {
    request.attempts++;
    request.requestedAt = Date.now();
    request.completedSeenAt = null;
  }
}

/**
 * The newest review that ends with a marker naming the request's kind
 * and the head: `<!-- <service>-review kind=<kind> sha=<head sha> ... -->`.
 * A marker quoted inside a review's text does not count.
 */
function markedReview(reviews, { service, kind }, head) {
  const marker = new RegExp(
    `<!-- ${escapeRegExp(service)}-review kind=${escapeRegExp(kind)} sha=([0-9a-f]{40})(?: [^>]*)? -->\\s*$`,
  );

  return reviews
    .filter((review) => review.body?.match(marker)?.[1] === head)
    .sort((a, b) => (b.submitted_at ?? "").localeCompare(a.submitted_at ?? ""))
    .at(0);
}

function reviewDetails(review) {
  return {
    review_id: review.id,
    review_url: review.html_url,
    submitted_at: review.submitted_at,
  };
}

/**
 * A refusal comment carries `<!-- <service>-review-refused` and names
 * the label. The name must stand alone, so a refusal of
 * `x-review:code-review:high` is not taken for `x-review:code-review`.
 */
function refusalComment(comments, { service, label, knownCommentIds }) {
  const marker = `<!-- ${service}-review-refused`;
  const naming = new RegExp(
    `(^|[^a-z0-9:-])${escapeRegExp(label)}($|[^a-z0-9:-])`,
  );

  return comments.find(
    (comment) =>
      !knownCommentIds.has(comment.id) &&
      comment.body?.includes(marker) &&
      naming.test(comment.body),
  );
}

/**
 * The newest check run the service names after the label, among those
 * that appeared after the request.
 */
function latestCheckRun(repository, head, { label, knownCheckIds }) {
  return checkRuns(repository, head, label)
    .filter(({ id }) => !knownCheckIds.has(id))
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .at(0);
}

function checkRuns(repository, head, label) {
  return (
    gh([
      "api",
      `repos/${repository}/commits/${head}/check-runs?check_name=${encodeURIComponent(label)}`,
    ]).check_runs ?? []
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
