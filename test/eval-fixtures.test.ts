// The land evals' workspace: the setup script builds it, and the fake gh
// in it serves the calls the skills and their scripts make.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryDirectory = join(import.meta.dir, "..");
const setupScript = join(
  repositoryDirectory,
  "evals",
  "land",
  "fixtures",
  "setup.sh",
);
const scriptsDirectory = join(repositoryDirectory, "scripts");

let workspace: string;

function run(
  command: string,
  args: string[],
  path = `.fake-bin:${process.env.PATH}`,
) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, PATH: path },
  });

  return {
    code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function events(): Record<string, unknown>[] {
  return readFileSync(join(workspace, ".fake-bin", "gh-calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line))
    .filter(
      (event): event is Record<string, unknown> =>
        typeof event === "object" && event !== null,
    );
}

function pushBranch(branch: string): void {
  run("git", ["checkout", "-q", "-b", branch]);
  writeFileSync(join(workspace, "CHANGE.md"), "A change\n");
  run("git", ["add", "CHANGE.md"]);
  run("git", ["commit", "-q", "-m", "Change"]);
  run("git", ["push", "-q", "origin", branch]);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ship-it-eval-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("the land eval workspace", () => {
  test("refuses to build without the fake gh on PATH", () => {
    const result = run("bash", [setupScript], process.env.PATH);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PATH=".fake-bin:$PATH"');
  });

  test("holds the invoices repository on main, pushed to its remote", () => {
    expect(run("bash", [setupScript]).code).toBe(0);
    expect(run("git", ["status", "--porcelain"]).stdout).toBe("");
    expect(run("git", ["ls-remote", "origin", "main"]).stdout).toContain(
      run("git", ["rev-parse", "HEAD"]).stdout,
    );
    expect(run("bun", ["test"]).code).toBe(0);
    expect(
      run("gh", ["api", "repos/{owner}/{repo}", "--jq", ".full_name"]).stdout,
    ).toBe("acme-books/invoices");
  });

  test("serves a draft PR through to a passing CI watch and ready", () => {
    run("bash", [setupScript]);
    pushBranch("invoice-download-log");
    writeFileSync(join(workspace, "body.md"), "The body\n");

    const created = run("gh", [
      "api",
      "repos/{owner}/{repo}/pulls",
      "-f",
      "head=acme-books:invoice-download-log",
      "-f",
      "base=main",
      "-f",
      "title=Log invoice downloads",
      "-F",
      "body=@body.md",
      "-F",
      "draft=true",
      "--jq",
      ".html_url",
    ]);
    const watch = run("bun", [
      join(scriptsDirectory, "ship-it-ci-watch.ts"),
      "1",
    ]);
    const labels = run("bun", [
      join(scriptsDirectory, "ship-it-review-list.ts"),
    ]);

    expect(created.stdout).toBe(
      "https://github.com/acme-books/invoices/pull/1",
    );
    expect(JSON.parse(watch.stdout)).toMatchObject({
      result: "passed",
      head: run("git", ["rev-parse", "HEAD"]).stdout,
      required: ["test"],
    });
    expect(JSON.parse(labels.stdout)).toEqual([]);
    expect(run("gh", ["pr", "ready", "1"]).code).toBe(0);
    expect(events()).toContainEqual(
      expect.objectContaining({ event: "pr.create", number: 1, draft: true }),
    );
    expect(events()).toContainEqual(
      expect.objectContaining({ event: "pr.ready", number: 1, ok: true }),
    );
    expect(events().some(({ event }) => event === "pr.merge")).toBe(false);
  });

  test("keeps every change when calls overlap", async () => {
    run("bash", [setupScript]);
    pushBranch("invoice-download-log");
    run("gh", ["pr", "create", "--draft", "--title", "Log", "--body", "x"]);

    const calls = [
      ["pr", "ready", "1"],
      ...Array.from({ length: 8 }, () => [
        "pr",
        "view",
        "1",
        "--json",
        "isDraft",
      ]),
    ].map(
      (args) =>
        Bun.spawn(["gh", ...args], {
          cwd: workspace,
          env: { ...process.env, PATH: `.fake-bin:${process.env.PATH}` },
          stdout: "ignore",
        }).exited,
    );

    await Promise.all(calls);

    expect(
      run("gh", ["pr", "view", "1", "--json", "isDraft", "--jq", ".isDraft"])
        .stdout,
    ).toBe("false");
  });

  test("logs every way to merge as a merge", () => {
    run("bash", [setupScript]);
    pushBranch("invoice-item-count");
    run("gh", [
      "pr",
      "create",
      "--draft",
      "--title",
      "Count items",
      "--body",
      "x",
    ]);
    run("gh", ["pr", "merge", "1", "--squash", "--auto"]);
    run("gh", ["api", "-X", "PUT", "repos/{owner}/{repo}/pulls/1/merge"]);
    run("gh", [
      "api",
      "graphql",
      "-f",
      'query=mutation { mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } }',
    ]);

    expect(
      events()
        .filter(({ event }) => event === "pr.merge")
        .map(({ how }) => how),
    ).toEqual(["auto", "api", "graphql"]);
  });

  test("refuses a call it does not know, and logs it", () => {
    run("bash", [setupScript]);

    const result = run("gh", ["release", "list"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("fake gh does not know: gh release list");
    expect(events().at(-1)).toMatchObject({ event: "unknown", ok: false });
  });
});
