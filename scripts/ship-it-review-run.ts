#!/usr/bin/env bun
// Requests reviews through their labels and waits until each one answers.

import {
  ScriptError,
  gh,
  ghRecord,
  ghRecords,
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
  resolveRepository,
  sleep,
  stringOrNull,
} from "./lib";

const USAGE = `Usage: ship-it-review-run.ts <pull request> <label>... [options]

Requests a review for each label on the pull request's head commit, then
waits until each review posted, was refused, ended without a review, or
ran out of time. A request that ended without a review or ran out of time
is made again, up to --retries times. A review that already posted on the
head is reported without a new request. Prints the outcome as JSON.

Arguments:
  <pull request>   A number or a github.com pull request URL
  <label>          A review label, as ship-it-review-list.ts prints it

Options:
  --repo owner/name     The repository (default: the URL's, or the current directory's)
  --timeout <minutes>   How long each request waits for an answer (default: 30)
  --interval <seconds>  Time between checks (default: 30)
  --retries <count>     Requests made again after no review or a timeout (default: 1)
`;

// GitHub's timestamps and this machine's clock can disagree by a little,
// so the comment listing starts this much before the earliest request.
const CLOCK_SKEW_MS = 2 * 60 * 1000;

type ReviewStatus =
  | "pending"
  | "posted"
  | "refused"
  | "unanswered"
  | "timeout"
  | "closed"
  | "superseded";

interface ReviewOutcome {
  reason?: string;
  refusal_url?: string | null;
  review_id?: number | null;
  review_url?: string | null;
  submitted_at?: string | null;
}

interface ReviewRequest extends ReviewOutcome {
  label: string;
  service: string;
  kind: string;
  status: ReviewStatus;
  attempts: number;
  requestedAt: number;
  completedSeenAt: number | null;
  knownCommentIds: Set<number>;
  knownCheckIds: Set<number>;
}

interface Review {
  id: number | null;
  body: string | null;
  html_url: string | null;
  submitted_at: string | null;
}

interface Comment {
  id: number | null;
  body: string | null;
  html_url: string | null;
}

interface CheckRun {
  id: number | null;
  status: string | null;
  conclusion: string | null;
  title: string | null;
  started_at: string;
}

await main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    valueFlags: ["repo", "timeout", "interval", "retries"],
  });
  const [pullRequestArgument, ...labelNames] = positionals;

  if (pullRequestArgument === undefined || labelNames.length === 0) {
    throw new ScriptError(
      `ship-it-review-run.ts needs a pull request and at least one label.\n\n${USAGE}`,
    );
  }

  const repository = resolveRepository(flags.repo, pullRequestArgument);
  const number = parsePullRequestNumber(pullRequestArgument);
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
  const settled: ReviewRequest[] = [];

  const settle = (
    request: ReviewRequest,
    status: ReviewStatus,
    details: ReviewOutcome = {},
  ) => {
    Object.assign(request, { status }, details);
    settled.push(request);
  };

  const postedReviews = reviews(repository, number);

  for (const request of requests) {
    const review = markedReview(postedReviews, request, head);

    if (review) {
      settle(request, "posted", reviewDetails(review));
    }
  }

  let pending = requests.filter((request) => !settled.includes(request));

  requestReviews(repository, number, head, pending);

  while (pending.length > 0) {
    // Each check waits for the last one: a poll, never a batch.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(intervalSeconds);

    const pullRequest = readPullRequest(repository, number);

    if (pullRequest.state !== "open") {
      for (const request of pending) {
        settle(request, "closed", {
          reason: `The pull request is ${pullRequest.state}.`,
        });
      }
      break;
    }

    if (pullRequest.head !== head) {
      for (const request of pending) {
        settle(request, "superseded", {
          reason: `The head moved to ${pullRequest.head}. Request the review again for the new head.`,
        });
      }
      break;
    }

    const earliestRequest = Math.min(
      ...pending.map((request) => request.requestedAt),
    );
    const currentReviews = reviews(repository, number);
    const comments = issueComments(
      repository,
      number,
      new Date(earliestRequest - CLOCK_SKEW_MS).toISOString(),
    );
    const again: ReviewRequest[] = [];

    const endAttempt = (
      request: ReviewRequest,
      status: ReviewStatus,
      reason?: string | null,
    ) => {
      if (request.attempts <= retries) {
        again.push(request);

        return;
      }

      settle(request, status, reason ? { reason } : {});
    };

    for (const request of pending) {
      const review = markedReview(currentReviews, request, head);

      if (review) {
        settle(request, "posted", reviewDetails(review));
        continue;
      }

      const refusal = refusalComment(comments, request);

      if (refusal) {
        settle(request, "refused", {
          reason: (refusal.body?.split("\n")[0] ?? "").trim(),
          refusal_url: refusal.html_url,
        });
        continue;
      }

      const check = latestCheckRun(repository, head, request);

      if (check?.status === "completed") {
        request.completedSeenAt ??= Date.now();

        if (Date.now() - request.completedSeenAt >= graceMs) {
          endAttempt(request, "unanswered", check.title || check.conclusion);
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
  const { head: currentHead } = readPullRequest(repository, number);

  printJson({
    repository,
    pull_request: number,
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

function retryCount(value: string): number {
  const count = Number(value);

  if (!Number.isInteger(count) || count < 0) {
    throw new ScriptError(
      `The --retries option needs a whole number of 0 or more, got "${value}".\n\n${USAGE}`,
    );
  }

  return count;
}

function openHead(repository: string, number: number): string {
  const pullRequest = readPullRequest(repository, number);

  if (pullRequest.state !== "open") {
    throw new ScriptError(
      `Pull request #${number} on ${repository} is ${pullRequest.state}. Reviews run only on an open pull request.`,
    );
  }

  return pullRequest.head;
}

function reviewRequests(
  repository: string,
  labelNames: string[],
): ReviewRequest[] {
  const existing = new Set(
    labelNamesOf(`repos/${repository}/labels?per_page=100`),
  );

  return [...new Set(labelNames)].map((label) => {
    const parsed = parseReviewLabel(label);

    if (!parsed) {
      throw new ScriptError(
        `${label} is not a review label. A review label looks like <service>-review:<kind>.`,
      );
    }

    if (!existing.has(label)) {
      throw new ScriptError(
        `The label ${label} does not exist on ${repository}. ship-it-review-list.ts lists the review labels it offers.`,
      );
    }

    return {
      label,
      service: parsed.service,
      kind: parsed.kind,
      status: "pending",
      attempts: 0,
      requestedAt: 0,
      completedSeenAt: null,
      knownCommentIds: new Set(),
      knownCheckIds: new Set(),
    };
  });
}

function labelNamesOf(path: string): string[] {
  return ghRecords(path).map(({ name }) => String(name));
}

function idsOf(items: { id: number | null }[]): Set<number> {
  return new Set(items.flatMap(({ id }) => (id === null ? [] : [id])));
}

/**
 * Adds the labels in one call. A label still on the pull request asks
 * for nothing when added again, so it comes off first. The comments and
 * checks that exist before the edit belong to earlier requests, so the
 * wait never takes them for this request's answer.
 */
function requestReviews(
  repository: string,
  number: number,
  head: string,
  requests: ReviewRequest[],
): void {
  if (requests.length === 0) {
    return;
  }

  const knownCommentIds = idsOf(issueComments(repository, number));

  for (const request of requests) {
    request.knownCommentIds = knownCommentIds;
    request.knownCheckIds = idsOf(checkRuns(repository, head, request.label));
  }

  const labels = `repos/${repository}/issues/${number}/labels`;
  const onPullRequest = new Set(labelNamesOf(labels));
  const stale = requests.filter(({ label }) => onPullRequest.has(label));

  for (const { label } of stale) {
    gh(["api", "-X", "DELETE", `${labels}/${encodeURIComponent(label)}`]);
  }

  gh([
    "api",
    "-X",
    "POST",
    labels,
    ...requests.flatMap(({ label }) => ["-f", `labels[]=${label}`]),
  ]);

  for (const request of requests) {
    request.attempts++;
    request.requestedAt = Date.now();
    request.completedSeenAt = null;
  }
}

function reviews(repository: string, number: number): Review[] {
  return ghRecords(`repos/${repository}/pulls/${number}/reviews`).map(
    (review) => ({
      id: numberOrNull(review.id),
      body: stringOrNull(review.body),
      html_url: stringOrNull(review.html_url),
      submitted_at: stringOrNull(review.submitted_at),
    }),
  );
}

function issueComments(
  repository: string,
  number: number,
  since?: string,
): Comment[] {
  const query = since === undefined ? "" : `?since=${since}`;

  return ghRecords(`repos/${repository}/issues/${number}/comments${query}`).map(
    (comment) => ({
      id: numberOrNull(comment.id),
      body: stringOrNull(comment.body),
      html_url: stringOrNull(comment.html_url),
    }),
  );
}

/**
 * The newest review that ends with a marker naming the request's kind
 * and the head: `<!-- <service>-review kind=<kind> sha=<head sha> ... -->`.
 * A marker quoted inside a review's text does not count.
 */
function markedReview(
  candidates: Review[],
  { service, kind }: ReviewRequest,
  head: string,
): Review | undefined {
  const marker = new RegExp(
    `<!-- ${escapeRegExp(service)}-review kind=${escapeRegExp(kind)} sha=([0-9a-f]{40})(?: [^>]*)? -->\\s*$`,
  );

  return candidates
    .filter((review) => review.body?.match(marker)?.[1] === head)
    .toSorted((a, b) =>
      (b.submitted_at ?? "").localeCompare(a.submitted_at ?? ""),
    )
    .at(0);
}

function reviewDetails(review: Review): ReviewOutcome {
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
function refusalComment(
  comments: Comment[],
  { service, label, knownCommentIds }: ReviewRequest,
): Comment | undefined {
  const marker = `<!-- ${service}-review-refused`;
  const naming = new RegExp(
    `(^|[^a-z0-9:-])${escapeRegExp(label)}($|[^a-z0-9:-])`,
  );

  return comments.find(
    (comment) =>
      (comment.id === null || !knownCommentIds.has(comment.id)) &&
      comment.body?.includes(marker) &&
      naming.test(comment.body),
  );
}

/**
 * The newest check run the service names after the label, among those
 * that appeared after the request.
 */
function latestCheckRun(
  repository: string,
  head: string,
  { label, knownCheckIds }: ReviewRequest,
): CheckRun | undefined {
  return checkRuns(repository, head, label)
    .filter(({ id }) => id === null || !knownCheckIds.has(id))
    .toSorted((a, b) => b.started_at.localeCompare(a.started_at))
    .at(0);
}

function checkRuns(
  repository: string,
  head: string,
  label: string,
): CheckRun[] {
  const response = ghRecord(
    `repos/${repository}/commits/${head}/check-runs?check_name=${encodeURIComponent(label)}`,
  );

  return records(response.check_runs).map((check) => ({
    id: numberOrNull(check.id),
    status: stringOrNull(check.status),
    conclusion: stringOrNull(check.conclusion),
    title: isRecord(check.output) ? stringOrNull(check.output.title) : null,
    started_at: stringOrNull(check.started_at) ?? "",
  }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
