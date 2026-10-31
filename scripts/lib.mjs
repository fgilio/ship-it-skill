/**
 * Shared runtime for the scripts.
 *
 * Every GitHub call goes through gh(), so argument passing, JSON
 * parsing, and failure messages stay in one place. The calls use the
 * REST API only (`gh api`), since some sessions block GitHub's GraphQL
 * API, which `gh pr` and `gh repo` call.
 */

import { spawnSync } from "node:child_process";

export const FOCUS_ORDER = ["correctness", "cleanup", "maintainability"];

const FOCUS_TAG = new RegExp(`\\[(${FOCUS_ORDER.join("|")})\\]`, "i");
const LABEL_PART = /^[a-z0-9][a-z0-9-]*$/;
const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;

// A stalled gh call would hold the wait past its own timeout.
const GH_TIMEOUT_SECONDS = Number(
  process.env.SHIP_IT_GH_TIMEOUT_SECONDS ?? 120,
);

export class ScriptError extends Error {}

export async function main(run) {
  try {
    await run();
  } catch (error) {
    const message =
      error instanceof ScriptError
        ? error.message
        : `Unexpected failure: ${error?.stack ?? error}`;

    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Parses `--flag value`, `--flag=value`, and boolean `--flag` arguments.
 */
export function parseArguments(
  argv,
  { usage, valueFlags = [], booleanFlags = [] },
) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage);
      process.exit(0);
    }

    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const [name, inlineValue] = splitFlag(argument.slice(2));

    if (booleanFlags.includes(name)) {
      flags[name] = true;
      continue;
    }

    if (!valueFlags.includes(name)) {
      throw new ScriptError(`Unknown option --${name}.\n\n${usage}`);
    }

    const value = inlineValue ?? argv[++index];

    if (value === undefined || value === "") {
      throw new ScriptError(`The --${name} option needs a value.\n\n${usage}`);
    }

    flags[name] = value;
  }

  return { flags, positionals };
}

function splitFlag(flag) {
  const boundary = flag.indexOf("=");

  return boundary === -1
    ? [flag, undefined]
    : [flag.slice(0, boundary), flag.slice(boundary + 1)];
}

export function positiveNumber(value, name, usage) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    throw new ScriptError(
      `The --${name} option needs a positive number, got "${value}".\n\n${usage}`,
    );
  }

  return number;
}

/**
 * Runs gh and returns its stdout parsed as JSON, or as text with
 * `json: false`. A failed call throws with gh's own message.
 */
export function gh(args, { json = true } = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: GH_TIMEOUT_SECONDS * 1000,
  });

  if (result.error?.code === "ENOENT") {
    throw new ScriptError(
      "Unable to find the gh executable on PATH. Install the GitHub CLI and run `gh auth login`, then try again. A session with the GitHub MCP server runs the same protocol through skills/review/without-gh.md.",
    );
  }

  if (result.error?.code === "ETIMEDOUT") {
    throw new ScriptError(
      `gh ${args.join(" ")} did not answer within ${GH_TIMEOUT_SECONDS} seconds. Run the script again: a review that posted meanwhile is reported without a new request.`,
    );
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();

    throw new ScriptError(`gh ${args.join(" ")} failed: ${detail}`);
  }

  if (!json) {
    return result.stdout;
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ScriptError(
      `gh ${args.join(" ")} returned output that is not JSON: ${result.stdout.slice(0, 200)}`,
    );
  }
}

/**
 * Every item of a paginated REST list, flattened across pages.
 */
export function ghList(path) {
  return gh(["api", "--paginate", "--slurp", path]).flat();
}

/**
 * The repository a command targets: --repo, then the repository of a
 * pull request URL, then the repository of the current directory.
 */
export function resolveRepository(repositoryFlag, pullRequestArgument) {
  const fromUrl = pullRequestArgument?.match(PULL_REQUEST_URL)?.[1];
  const repository =
    repositoryFlag ?? fromUrl ?? gh(["api", "repos/{owner}/{repo}"]).full_name;

  if (!REPOSITORY.test(repository)) {
    throw new ScriptError(
      `The repository must look like owner/name, got "${repository}".`,
    );
  }

  return repository;
}

export function parsePullRequestNumber(argument) {
  const number = Number(argument?.match(PULL_REQUEST_URL)?.[2] ?? argument);

  if (!Number.isInteger(number) || number <= 0) {
    throw new ScriptError(
      `The pull request must be a number or a github.com pull request URL, got "${argument}".`,
    );
  }

  return number;
}

/**
 * Splits `<service>-review:<kind>[:<level>]` into its parts, or returns
 * null for a label that does not request a review.
 */
export function parseReviewLabel(name) {
  const boundary = name.indexOf("-review:");

  if (boundary <= 0) {
    return null;
  }

  const service = name.slice(0, boundary);
  const [kind, level, ...extra] = name
    .slice(boundary + "-review:".length)
    .split(":");

  if (
    !LABEL_PART.test(service) ||
    !LABEL_PART.test(kind ?? "") ||
    (level !== undefined && !LABEL_PART.test(level)) ||
    extra.length > 0
  ) {
    return null;
  }

  return { service, kind, level: level ?? null };
}

export function parseFocus(description) {
  return description?.match(FOCUS_TAG)?.[1].toLowerCase() ?? null;
}

export function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
