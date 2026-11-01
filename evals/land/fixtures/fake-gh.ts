#!/usr/bin/env bun
// Stands in for the GitHub CLI inside an eval run. It serves one
// repository whose pull requests the session opens, answers CI with one
// required check that passes on every commit, offers no review labels,
// and logs every call it gets.
//
// The scaffold copies it to `<workspace>/.fake-bin/gh` beside `state.json`
// (FakeState below). Each call appends one JSON line to `gh-calls.jsonl`:
// the `event` the graders read (pr.create, pr.ready, pr.merge, pr.update,
// label.add, comment, read, unknown), its details, and the raw `args`.
// A call GitHub would refuse (an empty pull request, a ready one marked
// ready) fails with `UNSUPPORTED:` and logs why.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface FakePullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
}

interface FakeState {
  repo: string;
  login: string;
  defaultBranch: string;
  remote: string;
  requiredCheck: string;
  pulls: FakePullRequest[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Event = { event: string } & Record<string, Json>;

interface Answer {
  event: Event;
  body?: Json;
  text?: string;
  error?: string;
}

const ACTIONS_APP_ID = 15368;
const RUN_ID = 7001;
const JOB_ID = 8001;
const WORKFLOW = ".github/workflows/ci.yml";
const NO_SHA = "0".repeat(40);

const directory = import.meta.dir;
const statePath = join(directory, "state.json");
const logPath = join(directory, "gh-calls.jsonl");
const lockPath = join(directory, "state.lock");
const args = process.argv.slice(2);

/**
 * Holds the state for this call alone. A session can run gh calls side by
 * side, and each one reads, changes and saves the whole state. A lock left
 * by a call that died is taken over after ten seconds. Any other failure
 * to take it (no directory, no permission) ends the call.
 */
function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function lockState(): void {
  for (;;) {
    try {
      mkdirSync(lockPath);

      return;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }

      const age =
        Date.now() -
        (statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());

      if (age > 10_000) {
        rmSync(lockPath, { recursive: true, force: true });
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function isFakeState(value: unknown): value is FakeState {
  return (
    typeof value === "object" &&
    value !== null &&
    "repo" in value &&
    typeof value.repo === "string" &&
    "remote" in value &&
    typeof value.remote === "string" &&
    "pulls" in value &&
    Array.isArray(value.pulls)
  );
}

lockState();

const savedState = readFileSync(statePath, "utf8");
const parsedState: unknown = JSON.parse(savedState);

if (!isFakeState(parsedState)) {
  throw new Error(`The fake gh state in ${statePath} is not a FakeState.`);
}

const state = parsedState;
const [owner = "", name = ""] = state.repo.split("/");

/**
 * Runs the real git through the wrapper the scaffold put beside this file.
 */
function git(gitArgs: string[]): string {
  const result = spawnSync(join(directory, "git"), gitArgs, {
    encoding: "utf8",
  });

  return result.status === 0 ? result.stdout.trim() : "";
}

function headSha(branch: string): string {
  return (
    git(["--git-dir", state.remote, "rev-parse", `refs/heads/${branch}`]) ||
    NO_SHA
  );
}

function currentBranch(): string {
  return git(["branch", "--show-current"]);
}

function pullUrl(number: number): string {
  return `https://github.com/${state.repo}/pull/${number}`;
}

function findPull(reference: string | undefined): FakePullRequest | undefined {
  const number = Number(reference?.split("/").pop());

  if (Number.isInteger(number) && number > 0) {
    return state.pulls.find((pull) => pull.number === number);
  }

  const branch = reference ?? currentBranch();

  return state.pulls.findLast((pull) => pull.head === branch);
}

function restPull(pull: FakePullRequest): Json {
  return {
    number: pull.number,
    html_url: pullUrl(pull.number),
    url: `https://api.github.com/repos/${state.repo}/pulls/${pull.number}`,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: pull.draft,
    merged: pull.merged,
    mergeable: true,
    mergeable_state: "clean",
    head: {
      ref: pull.head,
      sha: headSha(pull.head),
      repo: { full_name: state.repo },
    },
    base: { ref: pull.base, repo: { full_name: state.repo } },
    labels: [],
    user: { login: state.login },
  };
}

/**
 * The fields `gh pr view --json` and `gh pr list --json` serve.
 */
function cliPull(pull: FakePullRequest): Record<string, Json> {
  return {
    number: pull.number,
    url: pullUrl(pull.number),
    title: pull.title,
    body: pull.body,
    state: pull.merged ? "MERGED" : pull.state.toUpperCase(),
    isDraft: pull.draft,
    headRefName: pull.head,
    headRefOid: headSha(pull.head),
    baseRefName: pull.base,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    labels: [],
    reviews: [],
    comments: [],
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: state.requiredCheck,
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowName: "CI",
      },
    ],
    author: { login: state.login },
  };
}

function pickFields(
  record: Record<string, Json>,
  fields: string | undefined,
): Json {
  if (!fields) {
    return record;
  }

  return Object.fromEntries(
    fields.split(",").map((field) => [field, record[field] ?? null]),
  );
}

function checkRun(sha: string): Json {
  return {
    id: JOB_ID,
    name: state.requiredCheck,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    output: { title: null },
    app: { id: ACTIONS_APP_ID, slug: "github-actions" },
    html_url: `https://github.com/${state.repo}/actions/runs/${RUN_ID}/job/${JOB_ID}`,
    details_url: `https://github.com/${state.repo}/actions/runs/${RUN_ID}/job/${JOB_ID}`,
  };
}

function workflowRun(sha: string): Json {
  return {
    id: RUN_ID,
    name: "CI",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    path: WORKFLOW,
    html_url: `https://github.com/${state.repo}/actions/runs/${RUN_ID}`,
  };
}

/**
 * Splits `gh` arguments into positionals and flags. A flag takes the next
 * argument as its value unless it is one of the booleans gh knows.
 */
function parse(rest: string[]): {
  positionals: string[];
  flags: Map<string, string[]>;
} {
  const booleans = new Set([
    "--paginate",
    "--slurp",
    "--draft",
    "-d",
    "--fill",
    "--squash",
    "--merge",
    "--rebase",
    "--auto",
    "--admin",
    "--delete-branch",
    "-i",
    "--include",
    "--silent",
    "--web",
    "--undo",
    "--watch",
    "--fail-fast",
    "--required",
  ]);
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index] ?? "";

    if (!argument.startsWith("-") || argument === "-") {
      positionals.push(argument);
      continue;
    }

    const [flag = "", inline] = argument.split(/=(.*)/s);
    const value =
      inline ?? (booleans.has(flag) ? "true" : (rest[++index] ?? ""));

    flags.set(flag, [...(flags.get(flag) ?? []), value]);
  }

  return { positionals, flags };
}

function flagValue(
  flags: Map<string, string[]>,
  ...names: string[]
): string | undefined {
  return names.flatMap((flag) => flags.get(flag) ?? []).at(-1);
}

function readFieldValue(raw: string, typed: boolean): Json {
  if (raw.startsWith("@")) {
    return readFileSync(raw.slice(1), "utf8");
  }

  if (!typed) {
    return raw;
  }

  if (raw === "true" || raw === "false") {
    return raw === "true";
  }

  return raw !== "" && /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

/**
 * The request body `gh api` builds from -f (strings) and -F (typed) fields.
 */
function apiFields(flags: Map<string, string[]>): Record<string, Json> {
  const fields: Record<string, Json> = {};
  const add = (pair: string, typed: boolean) => {
    const [rawKey = "", raw = ""] = pair.split(/=(.*)/s);
    const key = rawKey.replace(/\[\]$/, "");
    const value = readFieldValue(raw, typed);
    const existing = fields[key];

    fields[key] = rawKey.endsWith("[]")
      ? [...(Array.isArray(existing) ? existing : []), value]
      : value;
  };

  for (const pair of [
    ...(flags.get("-f") ?? []),
    ...(flags.get("--raw-field") ?? []),
  ]) {
    add(pair, false);
  }

  for (const pair of [
    ...(flags.get("-F") ?? []),
    ...(flags.get("--field") ?? []),
  ]) {
    add(pair, true);
  }

  const input = flagValue(flags, "--input");

  if (input) {
    const parsed: unknown = JSON.parse(readFileSync(input, "utf8"));

    if (typeof parsed === "object" && parsed !== null) {
      Object.assign(fields, parsed);
    }
  }

  return fields;
}

function text(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}

interface NewPull {
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

/**
 * Opens the pull request the way GitHub would, from the branches on the
 * remote, and logs what it carries: its head commit, the commits it adds
 * and the files it changes. GitHub refuses a pull request with nothing to
 * merge, and so does the fake.
 */
function openPull(
  fields: NewPull,
  respond: (pull: FakePullRequest) => Omit<Answer, "event">,
): Answer {
  const head = fields.head.split(":").pop() ?? fields.head;
  const headCommit = git([
    "--git-dir",
    state.remote,
    "rev-parse",
    "--verify",
    "-q",
    `refs/heads/${head}`,
  ]);
  const baseCommit = git([
    "--git-dir",
    state.remote,
    "rev-parse",
    "--verify",
    "-q",
    `refs/heads/${fields.base}`,
  ]);
  const range = `${baseCommit}...${headCommit}`;
  const commits = Number(
    git([
      "--git-dir",
      state.remote,
      "rev-list",
      "--count",
      `${baseCommit}..${headCommit}`,
    ]) || 0,
  );
  const refused = (reason: string): Answer => ({
    event: { event: "pr.create.refused", head, base: fields.base, reason },
    error: `UNSUPPORTED: ${reason}`,
  });

  if (headCommit === "") {
    return refused(`the branch ${head} is not on the remote. Push it first.`);
  }

  if (baseCommit === "") {
    return refused(`the base branch ${fields.base} is not on the remote.`);
  }

  if (headCommit === baseCommit || commits === 0) {
    return refused(
      `${head} has no commits ahead of ${fields.base}, so the pull request has nothing to merge.`,
    );
  }

  const pull: FakePullRequest = {
    number: state.pulls.length + 1,
    ...fields,
    head,
    state: "open",
    merged: false,
  };

  state.pulls.push(pull);

  return {
    event: {
      event: "pr.create",
      number: pull.number,
      draft: pull.draft,
      head: pull.head,
      base: pull.base,
      title: pull.title,
      headSha: headCommit,
      commits,
      files: git(["--git-dir", state.remote, "diff", "--name-only", range])
        .split("\n")
        .filter(Boolean),
      stat: git(["--git-dir", state.remote, "diff", "--shortstat", range]),
    },
    ...respond(pull),
  };
}

/**
 * Takes a draft out of draft. GitHub answers a pull request that is
 * already ready with an error, and so does the fake.
 */
function markReady(
  pull: FakePullRequest | undefined,
  body: Answer["body"],
  message?: string,
): Answer {
  if (!pull) {
    return { event: { event: "pr.ready" }, error: "no pull request found" };
  }

  if (!pull.draft) {
    return {
      event: { event: "pr.ready", number: pull.number, reason: "not a draft" },
      error: `UNSUPPORTED: pull request ${state.repo}#${pull.number} is not a draft.`,
    };
  }

  pull.draft = false;

  return {
    event: { event: "pr.ready", number: pull.number },
    ...(body === undefined ? {} : { body }),
    ...(message === undefined ? {} : { text: message }),
  };
}

function merge(pull: FakePullRequest | undefined, how: string): Answer {
  if (!pull) {
    return { event: { event: "pr.merge", how }, error: "no pull request" };
  }

  pull.merged = true;
  pull.state = "closed";

  return {
    event: { event: "pr.merge", number: pull.number, how },
    body: { merged: true, sha: headSha(pull.head) },
    text: `Merged pull request ${state.repo}#${pull.number}`,
  };
}

function read(body: Json): Answer {
  return { event: { event: "read" }, body };
}

function answerPullRoute(
  method: string,
  pull: FakePullRequest,
  rest: string,
  fields: Record<string, Json>,
): Answer {
  if (rest === "") {
    if (method === "PATCH") {
      pull.title = text(fields.title) || pull.title;
      pull.body = text(fields.body) || pull.body;
      pull.base = text(fields.base) || pull.base;

      if (fields.state === "closed") {
        pull.state = "closed";
      }

      return {
        event: { event: "pr.update", number: pull.number },
        body: restPull(pull),
      };
    }

    return read(restPull(pull));
  }

  if (rest === "/merge") {
    return method === "GET"
      ? { event: { event: "read" }, error: "HTTP 404: Not Found" }
      : merge(pull, "api");
  }

  if (rest === "/comments" && method === "POST") {
    return {
      event: { event: "comment", number: pull.number },
      body: { id: 1 },
    };
  }

  return read([]);
}

function answerApi(rest: string[]): Answer {
  const { positionals, flags } = parse(rest);
  const fields = apiFields(flags);
  const rawPath = (positionals[0] ?? "")
    .replace(/^\//, "")
    .replaceAll("{owner}", owner)
    .replaceAll("{repo}", name);
  const [path = "", query = ""] = rawPath.split("?");
  const hasFields = Object.keys(fields).length > 0;
  const method = (
    flagValue(flags, "-X", "--method") ?? (hasFields ? "POST" : "GET")
  ).toUpperCase();
  const search = new URLSearchParams(query);
  const repoPath = `repos/${state.repo}`;

  if (method === "GET") {
    for (const [key, value] of Object.entries(fields)) {
      search.set(
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      );
    }
  }

  if (path === "graphql") {
    return answerGraphql(text(fields.query));
  }

  if (path === "user") {
    return read({ login: state.login, id: 1 });
  }

  if (path === repoPath) {
    return read({
      full_name: state.repo,
      name,
      owner: { login: owner },
      default_branch: state.defaultBranch,
      html_url: `https://github.com/${state.repo}`,
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_auto_merge: true,
      delete_branch_on_merge: true,
      private: false,
    });
  }

  if (!path.startsWith(`${repoPath}/`)) {
    return { event: { event: "unknown" }, error: "HTTP 404: Not Found" };
  }

  const route = path.slice(repoPath.length);

  if (route === "/pulls") {
    if (method === "POST") {
      return openPull(
        {
          title: text(fields.title),
          body: text(fields.body),
          head: text(fields.head),
          base: text(fields.base) || state.defaultBranch,
          draft: fields.draft === true || fields.draft === "true",
        },
        (pull) => ({ body: restPull(pull) }),
      );
    }

    const head = search.get("head")?.split(":").pop();
    const wanted = search.get("state") ?? "open";

    return read(
      state.pulls
        .filter((pull) => !head || pull.head === head)
        .filter((pull) => wanted === "all" || pull.state === wanted)
        .map(restPull),
    );
  }

  const pullMatch = route.match(/^\/pulls\/(\d+)(.*)$/);

  if (pullMatch) {
    const pull = findPull(pullMatch[1]);

    return pull
      ? answerPullRoute(method, pull, pullMatch[2] ?? "", fields)
      : { event: { event: "read" }, error: "HTTP 404: Not Found" };
  }

  const issueMatch = route.match(/^\/issues\/(\d+)\/(labels|comments)/);

  if (issueMatch && method === "POST") {
    return {
      event: {
        event: issueMatch[2] === "labels" ? "label.add" : "comment",
        number: Number(issueMatch[1]),
      },
      body: issueMatch[2] === "labels" ? [] : { id: 1 },
    };
  }

  const commitMatch = route.match(/^\/commits\/([^/]+)(\/.*)?$/);

  if (commitMatch) {
    const sha = commitMatch[1] ?? NO_SHA;

    if (commitMatch[2] === "/check-runs") {
      return read({ total_count: 1, check_runs: [checkRun(sha)] });
    }

    if (commitMatch[2] === "/status") {
      return read({ state: "success", statuses: [], sha });
    }

    return read({ sha });
  }

  if (route === "/actions/runs") {
    const sha = search.get("head_sha") ?? NO_SHA;

    return read({ total_count: 1, workflow_runs: [workflowRun(sha)] });
  }

  if (route.startsWith(`/actions/runs/${RUN_ID}`)) {
    if (route.endsWith("/pending_deployments")) {
      return read([]);
    }

    if (route.endsWith("/jobs")) {
      return read({ total_count: 1, jobs: [checkRun(NO_SHA)] });
    }

    return read(workflowRun(NO_SHA));
  }

  if (route === `/rules/branches/${state.defaultBranch}`) {
    return read([
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: state.requiredCheck, integration_id: ACTIONS_APP_ID },
          ],
        },
      },
    ]);
  }

  if (route.includes("/protection")) {
    return {
      event: { event: "read" },
      error: "HTTP 404: Branch not protected",
    };
  }

  if (route.startsWith("/branches/")) {
    return read({ name: route.split("/")[2] ?? "", protected: true });
  }

  if (
    /^\/(labels|issues\/\d+\/(labels|comments)|environments|deployments|commits|actions\/runs\/\d+\/jobs)/.test(
      route,
    )
  ) {
    return read([]);
  }

  return { event: { event: "unknown" }, error: "HTTP 404: Not Found" };
}

function answerGraphql(query: string): Answer {
  const number = Number(query.match(/number:\s*(\d+)/)?.[1]);
  const pull = findPull(Number.isInteger(number) ? String(number) : undefined);

  if (/mergePullRequest|enablePullRequestAutoMerge/.test(query)) {
    return merge(pull, "graphql");
  }

  if (query.includes("markPullRequestReadyForReview")) {
    return markReady(pull, { data: {} });
  }

  if (query.includes("reviewThreads")) {
    return read({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
  }

  if (query.includes("viewerDefaultMergeMethod")) {
    return read({
      data: { repository: { viewerDefaultMergeMethod: "SQUASH" } },
    });
  }

  return {
    event: { event: "unknown" },
    error: "fake gh serves no such GraphQL query",
  };
}

function answerPr(subcommand: string, rest: string[]): Answer {
  const { positionals, flags } = parse(rest);
  const pull = findPull(positionals[0]);
  const json = flagValue(flags, "--json");

  switch (subcommand) {
    case "create": {
      const bodyFile = flagValue(flags, "--body-file", "-F");
      return openPull(
        {
          title: flagValue(flags, "--title", "-t") ?? "",
          body: bodyFile
            ? readFileSync(bodyFile, "utf8")
            : (flagValue(flags, "--body", "-b") ?? ""),
          head: flagValue(flags, "--head", "-H") ?? currentBranch(),
          base: flagValue(flags, "--base", "-B") ?? state.defaultBranch,
          draft: flags.has("--draft") || flags.has("-d"),
        },
        (created) => ({ text: pullUrl(created.number) }),
      );
    }

    case "ready": {
      return markReady(
        pull,
        undefined,
        `Pull request ${state.repo}#${pull?.number ?? 0} is marked as "ready for review"`,
      );
    }

    case "merge": {
      return merge(pull, flags.has("--auto") ? "auto" : "cli");
    }

    case "edit": {
      if (!pull) {
        return {
          event: { event: "pr.update" },
          error: "no pull request found",
        };
      }

      const bodyFile = flagValue(flags, "--body-file");

      pull.title = flagValue(flags, "--title", "-t") ?? pull.title;
      pull.body = bodyFile
        ? readFileSync(bodyFile, "utf8")
        : (flagValue(flags, "--body", "-b") ?? pull.body);

      return {
        event: { event: "pr.update", number: pull.number },
        text: pullUrl(pull.number),
      };
    }

    case "comment": {
      return {
        event: { event: "comment", number: pull?.number ?? null },
        text: `${pullUrl(pull?.number ?? 0)}#issuecomment-1`,
      };
    }

    case "view": {
      if (!pull) {
        return {
          event: { event: "read" },
          error: `no pull requests found for branch "${currentBranch()}"`,
        };
      }

      return json
        ? read(pickFields(cliPull(pull), json))
        : {
            event: { event: "read" },
            text: `${pull.title}\n${pullUrl(pull.number)}`,
          };
    }

    case "list": {
      const head = flagValue(flags, "--head", "-H");
      const pulls = state.pulls.filter(
        (candidate) => !head || candidate.head === head,
      );

      return json
        ? read(pulls.map((candidate) => pickFields(cliPull(candidate), json)))
        : {
            event: { event: "read" },
            text: pulls
              .map((candidate) => `${candidate.number}\t${candidate.title}`)
              .join("\n"),
          };
    }

    case "checks": {
      return {
        event: { event: "read" },
        text: `${state.requiredCheck}\tpass\t1s\thttps://github.com/${state.repo}/actions/runs/${RUN_ID}/job/${JOB_ID}`,
      };
    }

    default: {
      return {
        event: { event: "unknown" },
        error: `fake gh does not know: gh pr ${subcommand}`,
      };
    }
  }
}

function answer(): Answer {
  const [command = "", subcommand = "", ...rest] = args;

  if (command === "--version" || command === "version") {
    return { event: { event: "read" }, text: "gh version 2.80.0 (fake)" };
  }

  if (command === "auth") {
    return {
      event: { event: "read" },
      text: `github.com\n  ✓ Logged in to github.com account ${state.login}`,
    };
  }

  if (command === "api") {
    return answerApi([subcommand, ...rest]);
  }

  if (command === "pr") {
    return answerPr(subcommand, rest);
  }

  if (command === "repo" && subcommand === "view") {
    const { flags } = parse(rest);

    return read(
      pickFields(
        {
          nameWithOwner: state.repo,
          name,
          owner: { login: owner },
          url: `https://github.com/${state.repo}`,
          defaultBranchRef: { name: state.defaultBranch },
        },
        flagValue(flags, "--json"),
      ),
    );
  }

  if (command === "label" && subcommand === "list") {
    return read([]);
  }

  if (command === "run" && subcommand === "list") {
    return read([workflowRun(NO_SHA)]);
  }

  return {
    event: { event: "unknown" },
    error: `fake gh does not know: gh ${args.join(" ")}`,
  };
}

/**
 * Prints the answer the way gh does: --jq through jq, --paginate --slurp
 * as a list of pages, strings as they are.
 */
function print(result: Answer): void {
  if (result.error !== undefined) {
    process.stderr.write(`${result.error}\n`);
    process.exitCode = 1;

    return;
  }

  if (result.text !== undefined) {
    process.stdout.write(`${result.text}\n`);

    return;
  }

  const { flags } = parse(args.slice(1));
  const slurp = flags.has("--slurp");
  const body = slurp ? [result.body ?? null] : (result.body ?? null);
  const filter = flagValue(flags, "--jq", "-q");
  const output = JSON.stringify(body);

  if (!filter) {
    process.stdout.write(`${output}\n`);

    return;
  }

  const jq = spawnSync("jq", ["-r", filter], {
    input: output,
    encoding: "utf8",
  });

  process.stdout.write(jq.stdout);
  process.stderr.write(jq.stderr);
  process.exitCode = jq.status ?? 1;
}

function answerOrRefuse(): Answer {
  try {
    return answer();
  } catch (error) {
    return {
      event: { event: "unknown" },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const result = answerOrRefuse();

appendFileSync(
  logPath,
  `${JSON.stringify({ ...result.event, ok: result.error === undefined, args })}\n`,
);

const changedState = JSON.stringify(state, null, 2);

if (changedState !== savedState) {
  writeFileSync(statePath, changedState);
}

rmSync(lockPath, { recursive: true, force: true });
print(result);
