import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import type { FakeState } from "./fixtures/fake-gh";
import { createSandbox } from "./sandbox";
import type { Sandbox, ScriptResult } from "./sandbox";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const FAST = ["--interval", "0.01", "--timeout", "0.005"];

interface ReviewRunOutput {
  repository: string;
  pull_request: number;
  head: string;
  head_moved_to: string | null;
  reviews: {
    label: string;
    service: string;
    kind: string;
    status: string;
    attempts: number;
    reason?: string;
    refusal_url?: string;
    review_id?: number;
    review_url?: string;
    submitted_at?: string;
  }[];
}

function isReviewRunOutput(value: unknown): value is ReviewRunOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "reviews" in value &&
    Array.isArray(value.reviews)
  );
}

function parseReviewRunOutput(stdout: string): ReviewRunOutput {
  const output: unknown = JSON.parse(stdout);

  if (!isReviewRunOutput(output)) {
    throw new Error(`The review run printed no reviews: ${stdout}`);
  }

  return output;
}

// Each test runs the scripts as processes and waits through their polls.
setDefaultTimeout(60_000);

let sandbox: Sandbox;

function writeState(overrides: Partial<FakeState> = {}): void {
  sandbox.writeState({
    repo: "acme/shop",
    labels: [
      {
        name: "reviewbot-review:code-review",
        description: "[correctness] Ask reviewbot to run code-review",
      },
      {
        name: "reviewbot-review:code-review:high",
        description: "Ask reviewbot to run code-review at the high level",
      },
      {
        name: "reviewbot-review:simplify",
        description: "[cleanup] Ask reviewbot to run simplify",
      },
    ],
    pr: { number: 7, state: "OPEN", headRefOid: HEAD, labels: [] },
    reviews: [],
    comments: [],
    checkRuns: [],
    outcomes: {},
    ...overrides,
  });
}

function ghCalls(): string[][] {
  return sandbox.ghCalls();
}

function labelWrites(): string[][] {
  return ghCalls().filter(
    ([command, flag, method, path]) =>
      command === "api" &&
      flag === "-X" &&
      ["POST", "DELETE"].includes(method ?? "") &&
      path?.startsWith("repos/acme/shop/issues/7/labels"),
  );
}

function runScript(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<ScriptResult> {
  return sandbox.runScript(script, args, env);
}

async function runReviews(args: string[]): Promise<ReviewRunOutput> {
  const result = await runScript("ship-it-review-run.ts", [
    "7",
    ...FAST,
    ...args,
  ]);

  expect(result.code, result.stderr).toBe(0);

  return parseReviewRunOutput(result.stdout);
}

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.remove();
});

describe("ship-it-review-list.ts", () => {
  test("lists the labels that tag a focus, by focus then label", async () => {
    writeState({
      labels: [
        {
          name: "reviewbot-review:fgilio",
          description: "[maintainability] House style",
        },
        {
          name: "reviewbot-review:simplify",
          description: "[cleanup] Simplify",
        },
        {
          name: "otherbot-review:bugs",
          description: "Finds bugs [Correctness]",
        },
        {
          name: "reviewbot-review:code-review",
          description: "[correctness] Bugs",
        },
        {
          name: "reviewbot-review:code-review:high",
          description: "Bugs at high",
        },
        {
          name: "reviewbot-review:security",
          description: "[security] Unknown focus",
        },
        { name: "bug", description: "[correctness] Not a review label" },
        {
          name: "reviewbot-review:Bad Kind",
          description: "[cleanup] Malformed",
        },
      ],
    });

    const result = await runScript("ship-it-review-list.ts", []);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        label: "otherbot-review:bugs",
        service: "otherbot",
        kind: "bugs",
        focus: "correctness",
      },
      {
        label: "reviewbot-review:code-review",
        service: "reviewbot",
        kind: "code-review",
        focus: "correctness",
      },
      {
        label: "reviewbot-review:simplify",
        service: "reviewbot",
        kind: "simplify",
        focus: "cleanup",
      },
      {
        label: "reviewbot-review:fgilio",
        service: "reviewbot",
        kind: "fgilio",
        focus: "maintainability",
      },
    ]);
  });

  test("prints an empty list when no label tags a focus", async () => {
    writeState({
      labels: [{ name: "bug", description: "Something is broken" }],
    });

    const result = await runScript("ship-it-review-list.ts", [
      "--repo",
      "acme/shop",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });
});

describe("ship-it-review-run.ts", () => {
  test("requests every label in one edit and reports each posted review", async () => {
    writeState({
      outcomes: {
        "reviewbot-review:code-review": [{ afterPolls: 1, review: {} }],
        "reviewbot-review:simplify": [{ afterPolls: 2, review: {} }],
      },
    });

    const output = await runReviews([
      "reviewbot-review:code-review",
      "reviewbot-review:simplify",
    ]);

    expect(output.head).toBe(HEAD);
    expect(
      output.reviews.map(({ label, status, attempts }) => ({
        label,
        status,
        attempts,
      })),
    ).toEqual([
      {
        label: "reviewbot-review:code-review",
        status: "posted",
        attempts: 1,
      },
      { label: "reviewbot-review:simplify", status: "posted", attempts: 1 },
    ]);
    expect(output.reviews[0]?.review_url).toMatch(/pullrequestreview-/);
    expect(labelWrites()).toEqual([
      [
        "api",
        "-X",
        "POST",
        "repos/acme/shop/issues/7/labels",
        "-f",
        "labels[]=reviewbot-review:code-review",
        "-f",
        "labels[]=reviewbot-review:simplify",
      ],
    ]);
  });

  test("reports a review already posted on the head without asking again", async () => {
    writeState({
      reviews: [
        {
          id: 1,
          body: `Done.\n\n<!-- reviewbot-review kind=simplify sha=${HEAD} run=01jexample -->`,
          html_url: "https://github.com/acme/shop/pull/7#pullrequestreview-1",
          submitted_at: "2026-10-23T10:00:00Z",
        },
      ],
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    expect(output.reviews[0]?.status).toBe("posted");
    expect(output.reviews[0]?.attempts).toBe(0);
    expect(output.reviews[0]?.review_id).toBe(1);
    expect(labelWrites()).toEqual([]);
  });

  test("asks again when the posted review covers an older head", async () => {
    writeState({
      reviews: [
        {
          id: 1,
          body: `Done.\n\n<!-- reviewbot-review kind=simplify sha=${OTHER_HEAD} run=01jexample -->`,
          submitted_at: "2026-10-23T10:00:00Z",
        },
      ],
      outcomes: { "reviewbot-review:simplify": [{ review: {} }] },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    expect(output.reviews[0]?.status).toBe("posted");
    expect(output.reviews[0]?.attempts).toBe(1);
    expect(output.reviews[0]?.review_id).not.toBe(1);
  });

  test("reports a refusal with its reason", async () => {
    writeState({
      outcomes: {
        "reviewbot-review:simplify": [
          { refusal: "this head already has a simplify review." },
        ],
      },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    expect(output.reviews[0]?.status).toBe("refused");
    expect(output.reviews[0]?.reason).toMatch(/already has a simplify review/);
    expect(output.reviews[0]?.refusal_url).toMatch(/issuecomment-/);
  });

  test("does not take the refusal of a leveled label for the plain one", async () => {
    writeState({
      comments: [
        {
          id: 5,
          body: "The service did not start a review for `reviewbot-review:code-review:high`: admins only.\n\n<!-- reviewbot-review-refused request=3 -->",
          created_at: new Date().toISOString(),
        },
      ],
      outcomes: {
        "reviewbot-review:code-review": [{ afterPolls: 2, review: {} }],
      },
    });

    const output = await runReviews(["reviewbot-review:code-review"]);

    expect(output.reviews[0]?.status).toBe("posted");
  });

  test("asks again once when a request ends without a review", async () => {
    writeState({
      outcomes: {
        "reviewbot-review:simplify": [
          { check: { conclusion: "neutral", title: "Failed" } },
          { review: {} },
        ],
      },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    expect(output.reviews[0]?.status).toBe("posted");
    expect(output.reviews[0]?.attempts).toBe(2);
    expect(labelWrites().length).toBe(2);
  });

  test("reports no review after the retries run out", async () => {
    const failed = { check: { conclusion: "neutral", title: "No answer" } };

    writeState({ outcomes: { "reviewbot-review:simplify": [failed, failed] } });

    const output = await runReviews(["reviewbot-review:simplify"]);

    expect(output.reviews[0]?.status).toBe("unanswered");
    expect(output.reviews[0]?.reason).toBe("No answer");
    expect(output.reviews[0]?.attempts).toBe(2);
  });

  test("reports a timeout when nothing answers", async () => {
    writeState();

    const output = await runReviews([
      "reviewbot-review:simplify",
      "--retries",
      "0",
    ]);

    expect(output.reviews[0]?.status).toBe("timeout");
    expect(output.reviews[0]?.attempts).toBe(1);
  });

  test("stops waiting when the head moves", async () => {
    writeState({
      outcomes: { "reviewbot-review:simplify": [{ headMovesTo: OTHER_HEAD }] },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    expect(output.reviews[0]?.status).toBe("superseded");
    expect(output.reviews[0]?.reason).toMatch(new RegExp(OTHER_HEAD));
  });

  test("stops waiting when the pull request closes", async () => {
    writeState({
      outcomes: { "reviewbot-review:simplify": [{ state: "MERGED" }] },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    expect(output.reviews[0]?.status).toBe("closed");
  });

  test("takes a label still on the pull request off before adding it", async () => {
    writeState({
      pr: {
        number: 7,
        state: "OPEN",
        headRefOid: HEAD,
        labels: [{ name: "reviewbot-review:simplify" }],
      },
      outcomes: { "reviewbot-review:simplify": [{ review: {} }] },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    expect(output.reviews[0]?.status).toBe("posted");
    expect(labelWrites().map((call) => call.slice(2))).toEqual([
      ["DELETE", "repos/acme/shop/issues/7/labels/reviewbot-review%3Asimplify"],
      [
        "POST",
        "repos/acme/shop/issues/7/labels",
        "-f",
        "labels[]=reviewbot-review:simplify",
      ],
    ]);
  });

  test("takes the repository and number from a pull request URL", async () => {
    writeState({ outcomes: { "reviewbot-review:simplify": [{ review: {} }] } });

    const result = await runScript("ship-it-review-run.ts", [
      "https://github.com/acme/shop/pull/7",
      "reviewbot-review:simplify",
      ...FAST,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(parseReviewRunOutput(result.stdout).repository).toBe("acme/shop");
    expect(
      ghCalls().some((call) => call.includes("repos/{owner}/{repo}")),
    ).toBe(false);
  });

  test("calls only the REST API, which sessions that refuse GraphQL still serve", async () => {
    writeState({
      pr: {
        number: 7,
        state: "OPEN",
        headRefOid: HEAD,
        labels: [{ name: "reviewbot-review:simplify" }],
      },
      outcomes: { "reviewbot-review:simplify": [{ review: {} }] },
    });

    const result = await runScript("ship-it-review-run.ts", [
      "7",
      "reviewbot-review:simplify",
      ...FAST,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect([...new Set(ghCalls().map(([command]) => command))]).toEqual([
      "api",
    ]);
  });

  test("refuses a closed pull request", async () => {
    writeState({
      pr: { number: 7, state: "MERGED", headRefOid: HEAD, labels: [] },
    });

    const result = await runScript("ship-it-review-run.ts", [
      "7",
      "reviewbot-review:simplify",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Pull request #7 on acme\/shop is merged/);
    expect(labelWrites()).toEqual([]);
  });

  test("refuses a label the repository does not have", async () => {
    writeState();

    const result = await runScript("ship-it-review-run.ts", [
      "7",
      "reviewbot-review:security",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /The label reviewbot-review:security does not exist on acme\/shop/,
    );
  });

  test("refuses a label that requests no review", async () => {
    writeState();

    const result = await runScript("ship-it-review-run.ts", ["7", "bug"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/bug is not a review label/);
  });

  test("refuses a negative retry count", async () => {
    writeState();

    const result = await runScript("ship-it-review-run.ts", [
      "7",
      "reviewbot-review:simplify",
      "--retries",
      "-1",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--retries option needs a whole number/);
  });
  test("does not take a marker quoted inside a review for an answer", async () => {
    writeState({
      reviews: [
        {
          id: 1,
          body: `A review ends with <!-- reviewbot-review kind=simplify sha=${HEAD} run=01jexample --> and this one quotes it.`,
          submitted_at: "2026-10-23T10:00:00Z",
        },
      ],
      outcomes: { "reviewbot-review:simplify": [{ review: {} }] },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    expect(output.reviews[0]?.status).toBe("posted");
    expect(output.reviews[0]?.attempts).toBe(1);
    expect(output.reviews[0]?.review_id).not.toBe(1);
  });

  test("ignores a refusal that came before the request", async () => {
    writeState({
      comments: [
        {
          id: 5,
          body: "The service did not start a review for `reviewbot-review:simplify`: the head moved.\n\n<!-- reviewbot-review-refused request=3 -->",
          created_at: new Date().toISOString(),
        },
      ],
      outcomes: {
        "reviewbot-review:simplify": [{ afterPolls: 2, review: {} }],
      },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    expect(output.reviews[0]?.status).toBe("posted");
  });

  test("ignores a check that finished before the request", async () => {
    writeState({
      checkRuns: [
        {
          id: 1,
          name: "reviewbot-review:simplify",
          head_sha: HEAD,
          status: "completed",
          conclusion: "neutral",
          started_at: new Date().toISOString(),
          output: { title: "Failed" },
        },
      ],
      outcomes: {
        "reviewbot-review:simplify": [{ afterPolls: 3, review: {} }],
      },
    });

    const output = await runReviews([
      "reviewbot-review:simplify",
      "--timeout",
      "0.1",
    ]);

    expect(output.reviews[0]?.status).toBe("posted");
    expect(output.reviews[0]?.attempts).toBe(1);
  });

  test("reports a head that moved as the review posted", async () => {
    writeState({
      outcomes: {
        "reviewbot-review:simplify": [{ review: {}, headMovesTo: OTHER_HEAD }],
      },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    expect(output.reviews[0]?.status).toBe("posted");
    expect(output.head).toBe(HEAD);
    expect(output.head_moved_to).toBe(OTHER_HEAD);
  });

  test("finds a label past the first page of labels", async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({
      name: `area-${index}`,
      description: "",
    }));

    writeState({
      labelPages: [
        filler,
        [{ name: "reviewbot-review:late", description: "[cleanup] Late" }],
      ],
      outcomes: { "reviewbot-review:late": [{ review: {} }] },
    });

    const listed = await runScript("ship-it-review-list.ts", []);
    const output = await runReviews(["reviewbot-review:late"]);

    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ label: "reviewbot-review:late" }),
    ]);
    expect(output.reviews[0]?.status).toBe("posted");
  });

  test("stops with an error when a gh call stalls", async () => {
    writeState();

    const result = await runScript(
      "ship-it-review-run.ts",
      ["7", "reviewbot-review:simplify", ...FAST],
      { FAKE_GH_STALL_ON: "/reviews", SHIP_IT_GH_TIMEOUT_SECONDS: "0.5" },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/did not answer within 0.5 seconds/);
  });

  test("points to the MCP reference when gh is missing", async () => {
    writeState();

    const result = await runScript(
      "ship-it-review-run.ts",
      ["7", "reviewbot-review:simplify", ...FAST],
      { PATH: sandbox.root },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unable to find the gh executable/);
    expect(result.stderr).toMatch(/references\/github\.md/);
  });
});
