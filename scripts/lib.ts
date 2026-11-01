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

export async function main(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message =
      error instanceof ScriptError
        ? error.message
        : `Unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;

    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

interface ArgumentSpec<Value extends string, OptionalValue extends string> {
  usage: string;
  valueFlags: readonly Value[];
  optionalValueFlags?: readonly OptionalValue[];
}

export interface ParsedArguments<
  Value extends string,
  OptionalValue extends string,
> {
  flags: Partial<Record<Value, string>> &
    Partial<Record<OptionalValue, string | true>>;
  positionals: string[];
}

function isOneOf<Name extends string>(
  names: readonly Name[],
  candidate: string,
): candidate is Name {
  return names.some((name) => name === candidate);
}

/**
 * Parses `--flag value` and `--flag=value` arguments. An optional-value
 * flag is true on its own and takes an inline value.
 */
export function parseArguments<
  Value extends string,
  OptionalValue extends string = never,
>(
  argv: readonly string[],
  {
    usage,
    valueFlags,
    optionalValueFlags = [],
  }: ArgumentSpec<Value, OptionalValue>,
): ParsedArguments<Value, OptionalValue> {
  const values: Partial<Record<Value, string>> = {};
  const optionalValues: Partial<Record<OptionalValue, string | true>> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? "";

    if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage);
      process.exit(0);
    }

    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const [name, inlineValue] = splitFlag(argument.slice(2));

    if (isOneOf(optionalValueFlags, name)) {
      optionalValues[name] = inlineValue ?? true;
      continue;
    }

    if (!isOneOf(valueFlags, name)) {
      throw new ScriptError(`Unknown option --${name}.\n\n${usage}`);
    }

    const value = inlineValue ?? argv[++index];

    if (value === undefined || value === "") {
      throw new ScriptError(`The --${name} option needs a value.\n\n${usage}`);
    }

    values[name] = value;
  }

  return { flags: { ...values, ...optionalValues }, positionals };
}

function splitFlag(flag: string): [string, string | undefined] {
  const boundary = flag.indexOf("=");

  return boundary === -1
    ? [flag, undefined]
    : [flag.slice(0, boundary), flag.slice(boundary + 1)];
}

export function positiveNumber(
  value: string | number,
  name: string,
  usage: string,
): number {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    throw new ScriptError(
      `The --${name} option needs a positive number, got "${value}".\n\n${usage}`,
    );
  }

  return number;
}

function hasErrorCode(error: Error | undefined, code: string): boolean {
  return error !== undefined && "code" in error && error.code === code;
}

/**
 * Runs gh and returns its stdout parsed as JSON. A failed call throws
 * with gh's own message.
 */
export function gh(args: readonly string[]): unknown {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: GH_TIMEOUT_SECONDS * 1000,
  });

  if (hasErrorCode(result.error, "ENOENT")) {
    throw new ScriptError(
      "Unable to find the gh executable on PATH. Install the GitHub CLI and run `gh auth login`, then try again. A session with the GitHub MCP server does the same work by hand, as references/github.md says.",
    );
  }

  if (hasErrorCode(result.error, "ETIMEDOUT")) {
    throw new ScriptError(
      `gh ${args.join(" ")} did not answer within ${GH_TIMEOUT_SECONDS} seconds. Run the script again: a review that posted meanwhile is reported without a new request.`,
    );
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();

    throw new ScriptError(`gh ${args.join(" ")} failed: ${detail}`);
  }

  try {
    const parsed: unknown = JSON.parse(result.stdout);

    return parsed;
  } catch {
    throw new ScriptError(
      `gh ${args.join(" ")} returned output that is not JSON: ${result.stdout.slice(0, 200)}`,
    );
  }
}

/**
 * Every item of a paginated REST list, flattened across pages.
 */
export function ghList(path: string): unknown[] {
  const pages = gh(["api", "--paginate", "--slurp", path]);

  if (!Array.isArray(pages)) {
    throw new ScriptError(
      `gh api --paginate --slurp ${path} returned ${describeJson(pages)} instead of a list of pages.`,
    );
  }

  return pages.flat();
}

/**
 * Every record of a paginated REST list, flattened across pages.
 */
export function ghRecords(path: string): JsonRecord[] {
  return ghList(path).filter(isRecord);
}

/**
 * A REST object, read with `gh api <path>`.
 */
export function ghRecord(path: string): JsonRecord {
  const value = gh(["api", path]);

  if (!isRecord(value)) {
    throw new ScriptError(
      `gh api ${path} returned ${describeJson(value)} instead of an object.`,
    );
  }

  return value;
}

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The records of a JSON list, or none when the value is not a list.
 */
export function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function describeJson(value: unknown): string {
  return JSON.stringify(value)?.slice(0, 200) ?? "nothing";
}

/**
 * Reads a field the caller cannot go on without, and fails with the
 * request that returned the object otherwise.
 */
function requiredString(
  record: JsonRecord,
  key: string,
  source: string,
): string {
  const value = record[key];

  if (typeof value !== "string") {
    throw new ScriptError(
      `gh api ${source} returned no ${key} text: ${describeJson(record)}`,
    );
  }

  return value;
}

export function requiredNumber(
  record: JsonRecord,
  key: string,
  source: string,
): number {
  const value = record[key];

  if (typeof value !== "number") {
    throw new ScriptError(
      `gh api ${source} returned no ${key} number: ${describeJson(record)}`,
    );
  }

  return value;
}

/**
 * The repository a command targets: --repo, then the repository of a
 * pull request URL, then the repository of the current directory.
 */
export function resolveRepository(
  repositoryFlag: string | undefined,
  pullRequestArgument?: string,
): string {
  const fromUrl = pullRequestArgument?.match(PULL_REQUEST_URL)?.[1];
  const repository =
    repositoryFlag ??
    fromUrl ??
    requiredString(
      ghRecord("repos/{owner}/{repo}"),
      "full_name",
      "repos/{owner}/{repo}",
    );

  if (!REPOSITORY.test(repository)) {
    throw new ScriptError(
      `The repository must look like owner/name, got "${repository}".`,
    );
  }

  return repository;
}

export function parsePullRequestNumber(argument: string): number {
  const number = Number(argument.match(PULL_REQUEST_URL)?.[2] ?? argument);

  if (!Number.isInteger(number) || number <= 0) {
    throw new ScriptError(
      `The pull request must be a number or a github.com pull request URL, got "${argument}".`,
    );
  }

  return number;
}

export interface PullRequest {
  state: "open" | "closed" | "merged";
  head: string;
  base: string;
}

/**
 * The pull request's state, head commit and base branch.
 */
export function readPullRequest(
  repository: string,
  number: number,
): PullRequest {
  const path = `repos/${repository}/pulls/${number}`;
  const pullRequest = ghRecord(path);
  const head = isRecord(pullRequest.head) ? pullRequest.head : {};
  const base = isRecord(pullRequest.base) ? pullRequest.base : {};

  return {
    state:
      pullRequest.merged === true
        ? "merged"
        : requiredString(pullRequest, "state", path) === "open"
          ? "open"
          : "closed",
    head: requiredString(head, "sha", `${path} (head)`),
    base: requiredString(base, "ref", `${path} (base)`),
  };
}

export interface ReviewLabel {
  service: string;
  kind: string;
  level: string | null;
}

/**
 * Splits `<service>-review:<kind>[:<level>]` into its parts, or returns
 * null for a label that does not request a review.
 */
export function parseReviewLabel(name: string): ReviewLabel | null {
  const boundary = name.indexOf("-review:");

  if (boundary <= 0) {
    return null;
  }

  const service = name.slice(0, boundary);
  const [kind, level, ...extra] = name
    .slice(boundary + "-review:".length)
    .split(":");

  if (
    kind === undefined ||
    !LABEL_PART.test(service) ||
    !LABEL_PART.test(kind) ||
    (level !== undefined && !LABEL_PART.test(level)) ||
    extra.length > 0
  ) {
    return null;
  }

  return { service, kind, level: level ?? null };
}

export function parseFocus(description: string | null): string | null {
  return description?.match(FOCUS_TAG)?.[1]?.toLowerCase() ?? null;
}

export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
