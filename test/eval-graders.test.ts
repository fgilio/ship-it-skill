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

  test("rejects a chain on code, another mode, another path, and the skill text", () => {
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
        JSON.stringify({
          type: "user",
          message: { content: `${RUN_FILE}\n${run("evidence")}` },
        }),
      ),
    ).toBe(false);
  });
});

const prCreated = (head: string, title: string, body: string) =>
  JSON.stringify({
    event: "pr.create",
    number: 1,
    draft: true,
    head,
    base: "main",
    title,
    ok: true,
    args: ["pr", "create", "--title", title, "--body", body],
  });

describe("first-pr-only", () => {
  const pattern = grader("run-file-evidence-chain/graders/first-pr-only.md");
  test("finds the PDF PR by its branch or title", () => {
    expect(pattern.test(prCreated("invoice-pdf", "Add a format", ""))).toBe(
      true,
    );
    expect(
      pattern.test(
        prCreated("invoice-format", "Add the PDF download format", ""),
      ),
    ).toBe(true);
  });

  test("lets the logging PR's body mention the PDF PR to come", () => {
    expect(
      pattern.test(
        prCreated(
          "invoice-download-log",
          "Log invoice downloads",
          "The PDF format follows once the logs are in.",
        ),
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
    expect(bash("gh api -X PUT repos/{owner}/{repo}/pulls/1/merge")).toBe(true);
    expect(bash("gh pr merge 1 --auto --squash")).toBe(true);
    expect(bash("git -C . push origin HEAD:main")).toBe(true);
    expect(bash("git push origin main")).toBe(true);
  });

  test("passes a branch push and reads of main", () => {
    expect(
      bash("git push origin invoice-item-count && git diff origin/main...HEAD"),
    ).toBe(false);
    expect(bash("git push -u origin main-fix")).toBe(false);
    expect(bash("git fetch origin main && git rebase origin/main")).toBe(false);
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
