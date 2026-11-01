// The land evals' workspace: the setup script builds it, and the fake gh
// in it serves the calls the skills and their scripts make.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const mainUnchangedGrader = join(
  repositoryDirectory,
  "evals/land/run-file-evidence-chain/graders/main-unchanged.md",
);

let workspace: string;

function remoteMainMatchesGrader(): boolean {
  const [, frontMatter = ""] = readFileSync(mainUnchangedGrader, "utf8").split(
    "---",
  );
  const config: unknown = Bun.YAML.parse(frontMatter);

  if (
    typeof config !== "object" ||
    config === null ||
    !("pattern" in config) ||
    typeof config.pattern !== "string"
  ) {
    throw new Error(`The grader ${mainUnchangedGrader} has no pattern.`);
  }

  return new RegExp(config.pattern).test(
    readFileSync(
      join(
        workspace,
        ".git/fake-remote/acme-books/invoices.git/refs/heads/main",
      ),
      "utf8",
    ),
  );
}

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
    expect(events().find(({ event }) => event === "pr.create")).toMatchObject({
      event: "pr.create",
      number: 1,
      draft: true,
      headSha: run("git", ["rev-parse", "HEAD"]).stdout,
      commits: 1,
      files: ["CHANGE.md"],
    });
    expect(events().find(({ event }) => event === "pr.ready")).toMatchObject({
      event: "pr.ready",
      number: 1,
      ok: true,
    });
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

  test("refuses a pull request with nothing to merge", () => {
    run("bash", [setupScript]);
    run("git", ["push", "-q", "origin", "main:empty-branch"]);

    const fromMain = run("gh", [
      "pr",
      "create",
      "--title",
      "t",
      "--body",
      "b",
      "--head",
      "main",
    ]);
    const fromEmpty = run("gh", [
      "api",
      "repos/{owner}/{repo}/pulls",
      "-f",
      "head=acme-books:empty-branch",
      "-f",
      "base=main",
      "-f",
      "title=t",
    ]);
    const listWithoutGet = run("gh", [
      "api",
      "repos/{owner}/{repo}/pulls",
      "-f",
      "head=acme-books:empty-branch",
      "-f",
      "state=open",
    ]);

    expect(listWithoutGet.stderr).toContain(
      "HTTP 422: Validation Failed (base, title missing)",
    );

    const unpushed = run("gh", [
      "pr",
      "create",
      "--title",
      "t",
      "--body",
      "b",
      "--head",
      "not-pushed",
    ]);

    expect([fromMain.code, fromEmpty.code, unpushed.code]).toEqual([1, 1, 1]);
    expect(fromMain.stderr).toContain(
      "UNSUPPORTED: main has no commits ahead of main",
    );
    expect(fromEmpty.stderr).toContain(
      "UNSUPPORTED: empty-branch has no commits ahead of main",
    );
    expect(unpushed.stderr).toContain(
      "UNSUPPORTED: the branch not-pushed is not on the remote",
    );
    expect(
      events().filter(({ event }) => event === "pr.create.refused"),
    ).toHaveLength(4);
    expect(events().some(({ event }) => event === "pr.create")).toBe(false);
  });

  test("refuses to mark ready a pull request that is not a draft", () => {
    run("bash", [setupScript]);
    pushBranch("invoice-item-count");
    run("gh", ["pr", "create", "--title", "Count items", "--body", "x"]);

    const ready = run("gh", ["pr", "ready", "1"]);

    expect(ready.code).toBe(1);
    expect(ready.stderr).toContain(
      "UNSUPPORTED: pull request acme-books/invoices#1 is not a draft",
    );
    expect(events().at(-1)).toMatchObject({ event: "pr.ready", ok: false });
  });

  test("logs each bun test run with its exit code, commit and changes", () => {
    run("bash", [setupScript]);
    run("bun", ["test"]);
    writeFileSync(join(workspace, "README.md"), "Changed\n");
    run("bun", ["run", "test"]);

    const head = run("git", ["rev-parse", "HEAD"]).stdout;
    const changedTree = () => {
      run("git", ["add", "README.md"]);

      return run("git", ["write-tree"]).stdout;
    };

    expect(events().filter(({ event }) => event === "bun.test")).toEqual([
      {
        event: "bun.test",
        exit: 0,
        head,
        dirty: false,
        tree: run("git", ["rev-parse", "HEAD^{tree}"]).stdout,
      },
      { event: "bun.test", exit: 0, head, dirty: true, tree: changedTree() },
    ]);
  });

  test("logs the CI reads, the head marked ready and the PDF lines a PR adds, whatever git's diff settings", () => {
    run("bash", [setupScript]);
    run("git", ["checkout", "-q", "-b", "invoice-pdf"]);
    writeFileSync(
      join(workspace, "NOTES.md"),
      "Plan the PDF format\nand the csv one\n",
    );
    writeFileSync(
      join(workspace, "test", "refuse.test.ts"),
      'test("refuses pdf", () => expect(isFormat("pdf")).toBe(false));\n',
    );
    run("git", ["add", "NOTES.md", "test/refuse.test.ts"]);
    run("git", ["commit", "-q", "-m", "Notes"]);
    run("git", ["push", "-q", "origin", "invoice-pdf"]);
    // Config from the environment reaches git past GIT_CONFIG_GLOBAL and
    // GIT_CONFIG_NOSYSTEM, so it stands in for a system config that colors
    // diffs or runs an external diff tool.
    spawnSync(
      "gh",
      ["pr", "create", "--draft", "--title", "Notes", "--body", "x"],
      {
        cwd: workspace,
        env: {
          ...process.env,
          PATH: `.fake-bin:${process.env.PATH}`,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "color.diff",
          GIT_CONFIG_VALUE_0: "always",
          GIT_CONFIG_KEY_1: "diff.external",
          GIT_CONFIG_VALUE_1: "false",
        },
      },
    );
    run("bun", [join(scriptsDirectory, "ship-it-ci-watch.ts"), "1"]);
    run("gh", ["pr", "ready", "1"]);

    const head = run("git", ["rev-parse", "HEAD"]).stdout;

    expect(events().find(({ event }) => event === "pr.create")).toMatchObject({
      event: "pr.create",
      pdfLines: 1,
      headTree: run("git", ["rev-parse", "HEAD^{tree}"]).stdout,
    });
    expect(
      events()
        .filter(({ event }) => event === "ci.checks" || event === "pr.ready")
        .map(({ event, sha, headSha }) => [event, sha ?? headSha]),
    ).toEqual([
      ["ci.checks", head],
      ["pr.ready", head],
    ]);
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

  test("pushes the main the remote-main grader names", () => {
    run("bash", [setupScript]);

    expect(remoteMainMatchesGrader()).toBe(true);
  });

  test("pushes the same main under another git identity in the environment", () => {
    const result = spawnSync("bash", [setupScript], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `.fake-bin:${process.env.PATH}`,
        GIT_AUTHOR_NAME: "Someone Else",
        GIT_AUTHOR_EMAIL: "someone@example.com",
        GIT_COMMITTER_NAME: "Someone Else",
        GIT_COMMITTER_EMAIL: "someone@example.com",
      },
    });

    expect(result.status).toBe(0);
    expect(remoteMainMatchesGrader()).toBe(true);
  });

  test("pushes the same main under a global config with a hook template", () => {
    const configDirectory = mkdtempSync(
      join(tmpdir(), "ship-it-git-template-"),
    );
    const hooks = join(configDirectory, "template", "hooks");
    const globalConfig = join(configDirectory, "gitconfig");

    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-receive"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hooks, "pre-receive"), 0o755);
    writeFileSync(
      globalConfig,
      `[init]\n\ttemplateDir = ${join(configDirectory, "template")}\n\tdefaultBranch = trunk\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = false\n`,
    );

    const result = spawnSync("bash", [setupScript], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `.fake-bin:${process.env.PATH}`,
        GIT_CONFIG_GLOBAL: globalConfig,
      },
    });

    rmSync(configDirectory, { recursive: true, force: true });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(remoteMainMatchesGrader()).toBe(true);
  });

  test("pushes the same main under a git config that signs and hooks commits", () => {
    const configDirectory = mkdtempSync(join(tmpdir(), "ship-it-git-config-"));
    const hooks = join(configDirectory, "hooks");
    const globalConfig = join(configDirectory, "gitconfig");

    mkdirSync(hooks);
    writeFileSync(
      join(hooks, "commit-msg"),
      '#!/bin/sh\necho changed >> "$1"\n',
    );
    chmodSync(join(hooks, "commit-msg"), 0o755);
    writeFileSync(
      globalConfig,
      `[commit]\n\tgpgSign = true\n[tag]\n\tgpgSign = true\n[gpg]\n\tprogram = false\n[core]\n\thooksPath = ${hooks}\n\tautocrlf = true\n`,
    );

    const result = spawnSync("bash", [setupScript], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `.fake-bin:${process.env.PATH}`,
        GIT_CONFIG_GLOBAL: globalConfig,
      },
    });

    rmSync(configDirectory, { recursive: true, force: true });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(remoteMainMatchesGrader()).toBe(true);
  });

  test("ends a call it cannot lock, instead of waiting for the lock", () => {
    run("bash", [setupScript]);
    chmodSync(join(workspace, ".fake-bin"), 0o555);

    const result = spawnSync("gh", ["api", "user"], {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, PATH: `.fake-bin:${process.env.PATH}` },
      timeout: 5000,
    });

    chmodSync(join(workspace, ".fake-bin"), 0o755);

    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EACCES");
  });

  test("refuses a call it does not know, and logs it", () => {
    run("bash", [setupScript]);

    const result = run("gh", ["release", "list"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("fake gh does not know: gh release list");
    expect(events().at(-1)).toMatchObject({ event: "unknown", ok: false });
  });
});
