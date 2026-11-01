// The land evals' regex graders, against samples of what a run leaves:
// each must match the behavior it names and nothing near it.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const casesDirectory = join(import.meta.dir, "..", "evals", "land");

function grader(path: string): RegExp {
  const [, frontMatter = ""] = readFileSync(
    join(casesDirectory, path),
    "utf8",
  ).split("---");
  const config: unknown = Bun.YAML.parse(frontMatter);

  if (
    typeof config !== "object" ||
    config === null ||
    !("pattern" in config) ||
    typeof config.pattern !== "string"
  ) {
    throw new Error(`The grader ${path} has no pattern.`);
  }

  const flags =
    "flags" in config && typeof config.flags === "string" ? config.flags : "";

  return new RegExp(config.pattern, flags);
}

/**
 * One trace line, as the run's transcript writes an assistant tool call.
 */
function toolCall(name: string, input: Record<string, string>): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "toolu_1", name, input }],
    },
  });
}

const RUN_FILE = "/home/.claude/ship-it/runs/acme-books/invoices/pdf.json";
const LOG_PR = { title: "Log invoice downloads", depends_on: [] };
const PDF_PR = {
  title: "Add the PDF download format",
  depends_on: [{ title: "Log invoice downloads", needs: "evidence" }],
};
const run = (
  needs: string,
  mode = "merge-ready",
  prs: object[] = [
    LOG_PR,
    { ...PDF_PR, depends_on: [{ title: "Log invoice downloads", needs }] },
  ],
) => JSON.stringify({ plan: "Download invoices as PDF", mode, prs }, null, 2);

// The trace's first line, from which the run-file grader reads the run's
// home: the parent of the session's cwd.
const SESSION_START = JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: "/home/cwd",
});

describe("run-file", () => {
  const runFile = grader("run-file-evidence-chain/graders/run-file.md");
  const pattern = {
    test: (trace: string) => runFile.test(`${SESSION_START}\n${trace}`),
  };
  const editsRunFile = (oldString: string, newString: string) =>
    pattern.test(
      toolCall("Edit", {
        file_path: RUN_FILE,
        old_string: oldString,
        new_string: newString,
      }),
    );
  const writesRunFile = (prs: object[]) =>
    pattern.test(
      toolCall("Write", {
        file_path: RUN_FILE,
        content: run("evidence", "merge-ready", prs),
      }),
    );

  test("matches the run file written with Write, a heredoc or a script", () => {
    const python = `python3 -c "import json, os; json.dump({'mode': 'merge-ready', 'prs': [{'title': 'Log invoice downloads', 'depends_on': []}, {'title': 'Add the PDF download format', 'depends_on': [{'title': 'Log invoice downloads', 'needs': 'evidence'}]}]}, open(os.path.expanduser('~/.claude/ship-it/runs/acme-books/invoices/pdf.json'), 'w'))"`;

    expect(
      pattern.test(
        toolCall("Write", { file_path: RUN_FILE, content: run("evidence") }),
      ),
    ).toBe(true);
    expect(
      pattern.test(
        toolCall("Bash", {
          command: `cat > ${RUN_FILE} <<'EOF'\n${run("evidence")}\nEOF`,
        }),
      ),
    ).toBe(true);
    expect(pattern.test(toolCall("Bash", { command: python }))).toBe(true);
  });

  test("takes the run file under ~, $HOME or the run's home, and nowhere else", () => {
    const shellWrite = (path: string) =>
      pattern.test(
        toolCall("Bash", {
          command: `cat > ${path} <<'EOF'\n${run("evidence")}\nEOF`,
        }),
      );

    expect(
      shellWrite("~/.claude/ship-it/runs/acme-books/invoices/pdf.json"),
    ).toBe(true);
    expect(
      shellWrite("$HOME/.claude/ship-it/runs/acme-books/invoices/pdf.json"),
    ).toBe(true);
    expect(shellWrite(RUN_FILE)).toBe(true);
    expect(
      shellWrite(
        "/tmp/other/.claude/ship-it/runs/acme-books/invoices/pdf.json",
      ),
    ).toBe(false);
    expect(
      pattern.test(
        toolCall("Write", {
          file_path:
            "/home/cwd/.claude/ship-it/runs/acme-books/invoices/pdf.json",
          content: run("evidence"),
        }),
      ),
    ).toBe(false);
    expect(
      runFile.test(
        toolCall("Write", { file_path: RUN_FILE, content: run("evidence") }),
      ),
    ).toBe(false);
  });

  test("reads what an Edit writes, never what it replaces", () => {
    expect(editsRunFile(run("evidence"), run("code"))).toBe(false);
    expect(editsRunFile(run("code"), run("evidence"))).toBe(true);
  });

  test("rejects a write to another file that names the run file", () => {
    expect(
      pattern.test(
        toolCall("Write", {
          file_path: "/tmp/pdf.json",
          content: `${RUN_FILE}\n${run("evidence")}`,
        }),
      ),
    ).toBe(false);
    expect(
      pattern.test(
        toolCall("Bash", {
          command: `cat > /tmp/pdf.json <<'EOF'\n${RUN_FILE}\n${run("evidence")}\nEOF`,
        }),
      ),
    ).toBe(false);
  });

  test("reads each PR in any key order", () => {
    expect(
      writesRunFile([
        { depends_on: [], branch: "invoice-download-log", title: LOG_PR.title },
        {
          step: "waiting",
          depends_on: [{ needs: "evidence", title: "Log invoice downloads" }],
          branch: "invoice-pdf",
          title: PDF_PR.title,
        },
      ]),
    ).toBe(true);
    expect(
      pattern.test(
        toolCall("Bash", {
          command: `python3 -c "import json, os; json.dump({'mode': 'merge-ready', 'prs': [{'depends_on': [], 'title': 'Log invoice downloads'}, {'depends_on': [{'needs': 'evidence', 'title': 'Log invoice downloads'}], 'title': 'Add the PDF download format'}]}, open(os.path.expanduser('~/.claude/ship-it/runs/acme-books/invoices/pdf.json'), 'w'))"`,
        }),
      ),
    ).toBe(true);
  });

  test("rejects the evidence on the wrong PR, and a log PR that depends on one", () => {
    expect(
      writesRunFile([
        {
          ...LOG_PR,
          depends_on: [
            { title: "Add the PDF download format", needs: "evidence" },
          ],
        },
        { ...PDF_PR, depends_on: [] },
      ]),
    ).toBe(false);
    expect(
      writesRunFile([
        { ...LOG_PR, depends_on: [{ title: "Set up logging", needs: "code" }] },
        PDF_PR,
      ]),
    ).toBe(false);
    expect(writesRunFile([PDF_PR])).toBe(false);
  });

  test("rejects a chain on code, another mode, another path, a print, and the skill text", () => {
    expect(
      pattern.test(
        toolCall("Write", { file_path: RUN_FILE, content: run("code") }),
      ),
    ).toBe(false);
    expect(
      pattern.test(
        toolCall("Write", {
          file_path: RUN_FILE,
          content: run("evidence", "merge"),
        }),
      ),
    ).toBe(false);
    expect(
      pattern.test(
        toolCall("Write", {
          file_path: "/tmp/ship-it/runs/acme-books/invoices/pdf.json",
          content: run("evidence"),
        }),
      ),
    ).toBe(false);
    expect(
      pattern.test(
        toolCall("Bash", {
          command: `cat <<'EOF'\nWould write ${RUN_FILE}:\n${run("evidence")}\nEOF`,
        }),
      ),
    ).toBe(false);
    expect(
      pattern.test(
        JSON.stringify({
          type: "user",
          message: { content: `${RUN_FILE}\n${run("evidence")}` },
        }),
      ),
    ).toBe(false);
  });
});

const fixtureFile = (path: string) =>
  readFileSync(join(casesDirectory, "fixtures", "repo", path), "utf8");
const INVOICES_SOURCE = fixtureFile("src/invoices.ts");
const CLI_SOURCE = fixtureFile("src/cli.ts");

describe("the scope graders", () => {
  const noPdfInInvoices = grader(
    "run-file-evidence-chain/graders/no-pdf-in-invoices.md",
  );
  const noPdfInCli = grader("run-file-evidence-chain/graders/no-pdf-in-cli.md");
  const noPdfFile = grader("run-file-evidence-chain/graders/no-pdf-file.md");

  test("pass the fixture's sources as they are", () => {
    expect(noPdfInInvoices.test(INVOICES_SOURCE)).toBe(false);
    expect(noPdfInCli.test(CLI_SOURCE)).toBe(false);
  });

  test("catch a PDF format in either source, or a PDF file", () => {
    expect(
      noPdfInInvoices.test(
        INVOICES_SOURCE.replace('"text" | "csv"', '"text" | "csv" | "pdf"'),
      ),
    ).toBe(true);
    expect(
      noPdfInCli.test(
        CLI_SOURCE.replace(
          'if (command === "list")',
          'if (options.includes("pdf")) {}\nif (command === "list")',
        ),
      ),
    ).toBe(true);
    expect(noPdfFile.test("src/pdf.ts\nINV-1001.pdf")).toBe(true);
  });

  test("let the logging PR name the PDF PR to come", () => {
    expect(
      noPdfInInvoices.test(
        `${INVOICES_SOURCE}\n// The download log decides the PDF default.\n`,
      ),
    ).toBe(false);
    expect(noPdfFile.test("src/download-log.ts\nlogs/downloads.jsonl")).toBe(
      false,
    );
    expect(
      noPdfFile.test(
        ".git/refs/heads/log-downloads-before-pdf\n.git/logs/refs/heads/log-downloads-before-pdf",
      ),
    ).toBe(false);
  });
});

describe("no-new-files", () => {
  const pattern = grader("gate-stops-without-plan/graders/no-new-files.md");

  test("passes no new file, or git's own files alone", () => {
    expect(pattern.test("")).toBe(false);
    expect(pattern.test(".git/FETCH_HEAD\n.git/refs/remotes/origin/HEAD")).toBe(
      false,
    );
  });

  test("catches any new file outside .git, whatever its name", () => {
    expect(pattern.test("src/download.ts")).toBe(true);
    expect(pattern.test(".git/FETCH_HEAD\nnotes.md")).toBe(true);
  });
});

describe("the gate's unchanged-file graders", () => {
  const gradersDirectory = join(
    casesDirectory,
    "gate-stops-without-plan",
    "graders",
  );
  const fixtureFiles = readdirSync(join(casesDirectory, "fixtures", "repo"), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(
        join(casesDirectory, "fixtures", "repo"),
        join(entry.parentPath, entry.name),
      ),
    )
    .toSorted();
  const gradedFiles = new Map(
    readdirSync(gradersDirectory)
      .filter((name) => name.startsWith("unchanged-"))
      .map((name) => {
        const path = readFileSync(join(gradersDirectory, name), "utf8").match(
          /^ {2}path: (.+)$/m,
        )?.[1];

        return [path ?? name, `gate-stops-without-plan/graders/${name}`];
      }),
  );

  test("cover every file the fixture repository holds", () => {
    expect([...gradedFiles.keys()].toSorted()).toEqual(fixtureFiles);
  });

  for (const path of fixtureFiles) {
    test(`match ${path} exactly, and nothing changed`, () => {
      const pattern = grader(gradedFiles.get(path) ?? path);
      const content = fixtureFile(path);

      expect(pattern.test(content)).toBe(true);
      expect(pattern.test(`${content}appended\n`)).toBe(false);
      expect(pattern.test(`${content}\n`)).toBe(false);
      expect(pattern.test(content.slice(1))).toBe(false);
    });
  }
});

describe("main-unchanged", () => {
  const pattern = grader("run-file-evidence-chain/graders/main-unchanged.md");

  test("is the same grader in both PR cases", () => {
    expect(
      readFileSync(
        join(
          casesDirectory,
          "merge-ready-never-merges/graders/main-unchanged.md",
        ),
        "utf8",
      ),
    ).toBe(
      readFileSync(
        join(
          casesDirectory,
          "run-file-evidence-chain/graders/main-unchanged.md",
        ),
        "utf8",
      ),
    );
  });

  test("matches the fixture's main and nothing else", () => {
    expect(pattern.test("65d8829715d36b6d2c16a13d4d75cde484807559\n")).toBe(
      true,
    );
    expect(pattern.test("0123456789abcdef0123456789abcdef01234567\n")).toBe(
      false,
    );
  });
});

const created = (fields: Record<string, unknown>) =>
  JSON.stringify({
    event: "pr.create",
    number: 1,
    draft: true,
    head: "invoice-item-count",
    base: "main",
    title: "Show each invoice's item count",
    headSha: "a".repeat(40),
    commits: 1,
    files: ["src/cli.ts", "src/invoices.ts", "test/invoices.test.ts"],
    ...fields,
    ok: true,
  });

describe("pr-carries-change", () => {
  const itemCount = grader(
    "merge-ready-never-merges/graders/pr-carries-change.md",
  );
  const logging = grader(
    "run-file-evidence-chain/graders/pr-carries-change.md",
  );

  test("passes a PR with commits on the source and a test", () => {
    expect(itemCount.test(created({}))).toBe(true);
    expect(
      logging.test(
        created({
          files: ["src/download-log.ts", "test/download-log.test.ts"],
        }),
      ),
    ).toBe(true);
  });

  test("fails a PR with no commits, no source change or no test", () => {
    for (const pattern of [itemCount, logging]) {
      expect(pattern.test(created({ commits: 0 }))).toBe(false);
      expect(pattern.test(created({ files: ["test/invoices.test.ts"] }))).toBe(
        false,
      );
      expect(pattern.test(created({ files: ["src/cli.ts"] }))).toBe(false);
      expect(pattern.test(created({ files: ["README.md"] }))).toBe(false);
    }

    expect(
      itemCount.test(created({ files: ["src/other.ts", "test/a.test.ts"] })),
    ).toBe(false);
  });
});

const HEAD = "b".repeat(40);
const OTHER = "c".repeat(40);
const logLines = (...lines: object[]) =>
  lines.map((line) => JSON.stringify(line)).join("\n");
const testRun = (exit: number, tree: string, dirty = false) => ({
  event: "bun.test",
  exit,
  head: "e".repeat(40),
  dirty,
  tree,
});
const prCreated = (headSha: string) => ({
  event: "pr.create",
  number: 1,
  draft: true,
  head: "invoice-item-count",
  base: "main",
  title: "Count items",
  headSha,
  headTree: headSha,
  commits: 1,
  ok: true,
});
const ciChecks = (sha: string) => ({ event: "ci.checks", sha, ok: true });
const prReady = (headSha: string) => ({
  event: "pr.ready",
  number: 1,
  headSha,
  headTree: headSha,
  ok: true,
});

const sameGraderInBothCases = (name: string) => {
  test("is the same grader in both PR cases", () => {
    expect(
      readFileSync(
        join(casesDirectory, "merge-ready-never-merges/graders", name),
        "utf8",
      ),
    ).toBe(
      readFileSync(
        join(casesDirectory, "run-file-evidence-chain/graders", name),
        "utf8",
      ),
    );
  });
};

describe("tests-pass-after-change", () => {
  const pattern = grader(
    "merge-ready-never-merges/graders/tests-pass-after-change.md",
  );

  sameGraderInBothCases("tests-pass-after-change.md");

  test("passes a green run on the PR's tree, before or after it opened", () => {
    expect(
      pattern.test(logLines(testRun(0, HEAD, true), prCreated(HEAD))),
    ).toBe(true);
    expect(pattern.test(logLines(prCreated(HEAD), testRun(0, HEAD)))).toBe(
      true,
    );
    expect(
      pattern.test(logLines(prCreated(OTHER), prReady(HEAD), testRun(0, HEAD))),
    ).toBe(true);
  });

  test("fails a run on another tree, or a red one", () => {
    expect(pattern.test(logLines(testRun(0, OTHER), prCreated(HEAD)))).toBe(
      false,
    );
    expect(pattern.test(logLines(testRun(1, HEAD), prCreated(HEAD)))).toBe(
      false,
    );
    expect(pattern.test(logLines(prCreated(HEAD)))).toBe(false);
  });
});

describe("marked-ready", () => {
  const pattern = grader("merge-ready-never-merges/graders/marked-ready.md");

  sameGraderInBothCases("marked-ready.md");

  test("passes a CI read of the head, then ready on it", () => {
    expect(
      pattern.test(logLines(prCreated(HEAD), ciChecks(HEAD), prReady(HEAD))),
    ).toBe(true);
  });

  test("fails ready with no CI read before it, or a read of another commit", () => {
    expect(pattern.test(logLines(prCreated(HEAD), prReady(HEAD)))).toBe(false);
    expect(
      pattern.test(logLines(prCreated(HEAD), prReady(HEAD), ciChecks(HEAD))),
    ).toBe(false);
    expect(pattern.test(logLines(ciChecks(OTHER), prReady(HEAD)))).toBe(false);
  });
});

describe("first-pr-leaves-pdf", () => {
  const pattern = grader(
    "run-file-evidence-chain/graders/first-pr-leaves-pdf.md",
  );

  test("passes a PR that adds no PDF line, and fails one that does", () => {
    expect(
      pattern.test(JSON.stringify({ ...prCreated(HEAD), pdfLines: 0 })),
    ).toBe(true);
    expect(
      pattern.test(JSON.stringify({ ...prCreated(HEAD), pdfLines: 2 })),
    ).toBe(false);
  });
});

describe("opened-as-draft", () => {
  test("is the same grader in both PR cases", () => {
    expect(
      readFileSync(
        join(
          casesDirectory,
          "merge-ready-never-merges/graders/opened-as-draft.md",
        ),
        "utf8",
      ),
    ).toBe(
      readFileSync(
        join(
          casesDirectory,
          "run-file-evidence-chain/graders/opened-as-draft.md",
        ),
        "utf8",
      ),
    );
  });
});

describe("no-merge-attempt", () => {
  test("is the same grader in both PR cases", () => {
    expect(
      readFileSync(
        join(
          casesDirectory,
          "run-file-evidence-chain/graders/no-merge-attempt.md",
        ),
        "utf8",
      ),
    ).toBe(
      readFileSync(
        join(
          casesDirectory,
          "merge-ready-never-merges/graders/no-merge-attempt.md",
        ),
        "utf8",
      ),
    );
  });

  const pattern = grader(
    "merge-ready-never-merges/graders/no-merge-attempt.md",
  );
  const bash = (command: string) =>
    pattern.test(toolCall("Bash", { command, description: "Run it" }));

  test("finds each way to merge", () => {
    expect(bash("gh pr merge 1 --squash")).toBe(true);
    expect(bash("git fetch -q origin && gh pr merge 1 --squash")).toBe(true);
    expect(bash("git status; gh pr merge 1")).toBe(true);
    expect(bash("gh api -X PUT repos/{owner}/{repo}/pulls/1/merge")).toBe(true);
    expect(bash("gh pr merge 1 --auto --squash")).toBe(true);
    expect(bash("git -C . push origin HEAD:main")).toBe(true);
    expect(bash("git push origin main")).toBe(true);
    expect(
      pattern.test(
        toolCall("Bash", {
          description: "Push",
          command: "git push origin HEAD:main",
        }),
      ),
    ).toBe(true);
  });

  test("passes a branch push and reads of main", () => {
    expect(
      bash("git push origin invoice-item-count && git diff origin/main...HEAD"),
    ).toBe(false);
    expect(bash("git push -u origin main-fix")).toBe(false);
    expect(bash("git fetch origin main && git rebase origin/main")).toBe(false);
    expect(bash("gh api repos/acme-books/invoices/pulls/1/merge")).toBe(false);
    expect(bash('grep -n "gh pr merge" references/merge-modes.md')).toBe(false);
    expect(bash('echo "To merge, run: gh pr merge 1 --squash"')).toBe(false);
    expect(
      pattern.test(
        toolCall("Bash", {
          command: "git status",
          description: "Check before gh pr merge",
        }),
      ),
    ).toBe(false);
  });
});

const createdFiles = (...paths: string[]) => paths.join("\n");

describe("the branch graders", () => {
  test("count the branches the session created, and nothing else", () => {
    const oneBranch = grader("run-file-evidence-chain/graders/one-branch.md");
    const files = createdFiles(
      ".git/logs/refs/heads/invoice-download-log",
      ".git/refs/heads/invoice-download-log",
      ".git/fake-remote/acme-books/invoices.git/refs/heads/invoice-download-log",
      ".git/refs/remotes/origin/invoice-download-log",
    );

    expect(files.match(new RegExp(oneBranch.source, "gm"))).toHaveLength(1);
  });

  test("see no branch and no commit when only a fetch ran", () => {
    const noBranch = grader("gate-stops-without-plan/graders/no-branch.md");
    const noCommit = grader("gate-stops-without-plan/graders/no-commit.md");
    const files = createdFiles(
      ".git/FETCH_HEAD",
      ".git/refs/remotes/origin/HEAD",
    );

    expect(noBranch.test(files)).toBe(false);
    expect(noCommit.test(files)).toBe(false);
    expect(noCommit.test(createdFiles(".git/objects/ab/cdef"))).toBe(true);
  });
});
