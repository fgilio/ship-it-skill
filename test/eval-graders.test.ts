// The land evals' regex graders, against samples of what a run leaves:
// each must match the behavior it names and nothing near it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
const run = (needs: string, mode = "merge-ready") =>
  JSON.stringify(
    {
      plan: "Download invoices as PDF",
      mode,
      prs: [
        { title: "Log invoice downloads", depends_on: [] },
        {
          title: "Add the PDF download format",
          depends_on: [{ title: "Log invoice downloads", needs }],
        },
      ],
    },
    null,
    2,
  );

describe("run-file", () => {
  const pattern = grader("run-file-evidence-chain/graders/run-file.md");

  test("matches the run file written with Write, a heredoc or a script", () => {
    const python = `python3 -c "import json, os; json.dump({'mode': 'merge-ready', 'prs': [{'depends_on': []}, {'depends_on': [{'title': 'Log', 'needs': 'evidence'}]}]}, open(os.path.expanduser('~/.claude/ship-it/runs/acme-books/invoices/pdf.json'), 'w'))"`;

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

const INVOICES_SOURCE = readFileSync(
  join(casesDirectory, "fixtures", "repo", "src", "invoices.ts"),
  "utf8",
);
const CLI_SOURCE = readFileSync(
  join(casesDirectory, "fixtures", "repo", "src", "cli.ts"),
  "utf8",
);

describe("the scope graders", () => {
  const noPdfFormat = grader(
    "gate-stops-without-plan/graders/no-pdf-format.md",
  );
  const noPdfFile = grader("run-file-evidence-chain/graders/no-pdf-file.md");
  const cliUnchanged = grader(
    "gate-stops-without-plan/graders/cli-unchanged.md",
  );

  test("pass the fixture's sources as they are", () => {
    expect(noPdfFormat.test(INVOICES_SOURCE)).toBe(false);
    expect(cliUnchanged.test(CLI_SOURCE)).toBe(true);
  });

  test("catch a PDF format however a session added it", () => {
    expect(
      noPdfFormat.test(
        INVOICES_SOURCE.replace('"text" | "csv"', '"text" | "csv" | "pdf"'),
      ),
    ).toBe(true);
    expect(
      cliUnchanged.test(CLI_SOURCE.replace("text|csv]", "text|csv|pdf]")),
    ).toBe(false);
    expect(noPdfFile.test("src/pdf.ts\nINV-1001.pdf")).toBe(true);
  });

  test("let the logging PR name the PDF PR to come", () => {
    expect(
      noPdfFormat.test(
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

describe("no-merge-attempt", () => {
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
