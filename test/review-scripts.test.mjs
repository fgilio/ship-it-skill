import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createSandbox } from "./sandbox.mjs";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const FAST = ["--interval", "0.01", "--timeout", "0.005"];

let sandbox;

function writeState(overrides = {}) {
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

function ghCalls() {
  return sandbox.ghCalls();
}

function labelWrites() {
  return ghCalls().filter(
    ([command, flag, method, path]) =>
      command === "api" &&
      flag === "-X" &&
      ["POST", "DELETE"].includes(method) &&
      path.startsWith("repos/acme/shop/issues/7/labels"),
  );
}

function runScript(script, args, env = {}) {
  return sandbox.runScript(script, args, env);
}

async function runReviews(args) {
  const result = await runScript("ship-it-review-run.mjs", [
    "7",
    ...FAST,
    ...args,
  ]);

  assert.equal(result.code, 0, result.stderr);

  return JSON.parse(result.stdout);
}

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.remove();
});

describe("ship-it-review-list.mjs", () => {
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

    const result = await runScript("ship-it-review-list.mjs", []);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
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

    const result = await runScript("ship-it-review-list.mjs", [
      "--repo",
      "acme/shop",
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
  });
});

describe("ship-it-review-run.mjs", () => {
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

    assert.equal(output.head, HEAD);
    assert.deepEqual(
      output.reviews.map(({ label, status, attempts }) => ({
        label,
        status,
        attempts,
      })),
      [
        {
          label: "reviewbot-review:code-review",
          status: "posted",
          attempts: 1,
        },
        { label: "reviewbot-review:simplify", status: "posted", attempts: 1 },
      ],
    );
    assert.match(output.reviews[0].review_url, /pullrequestreview-/);
    assert.deepEqual(labelWrites(), [
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

    assert.equal(output.reviews[0].status, "posted");
    assert.equal(output.reviews[0].attempts, 0);
    assert.equal(output.reviews[0].review_id, 1);
    assert.deepEqual(labelWrites(), []);
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

    assert.equal(output.reviews[0].status, "posted");
    assert.equal(output.reviews[0].attempts, 1);
    assert.notEqual(output.reviews[0].review_id, 1);
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

    assert.equal(output.reviews[0].status, "refused");
    assert.match(output.reviews[0].reason, /already has a simplify review/);
    assert.match(output.reviews[0].refusal_url, /issuecomment-/);
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

    assert.equal(output.reviews[0].status, "posted");
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

    assert.equal(output.reviews[0].status, "posted");
    assert.equal(output.reviews[0].attempts, 2);
    assert.equal(labelWrites().length, 2);
  });

  test("reports no review after the retries run out", async () => {
    const failed = { check: { conclusion: "neutral", title: "No answer" } };

    writeState({ outcomes: { "reviewbot-review:simplify": [failed, failed] } });

    const output = await runReviews(["reviewbot-review:simplify"]);

    assert.equal(output.reviews[0].status, "unanswered");
    assert.equal(output.reviews[0].reason, "No answer");
    assert.equal(output.reviews[0].attempts, 2);
  });

  test("reports a timeout when nothing answers", async () => {
    writeState();

    const output = await runReviews([
      "reviewbot-review:simplify",
      "--retries",
      "0",
    ]);

    assert.equal(output.reviews[0].status, "timeout");
    assert.equal(output.reviews[0].attempts, 1);
  });

  test("stops waiting when the head moves", async () => {
    writeState({
      outcomes: { "reviewbot-review:simplify": [{ headMovesTo: OTHER_HEAD }] },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    assert.equal(output.reviews[0].status, "superseded");
    assert.match(output.reviews[0].reason, new RegExp(OTHER_HEAD));
  });

  test("stops waiting when the pull request closes", async () => {
    writeState({
      outcomes: { "reviewbot-review:simplify": [{ state: "MERGED" }] },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    assert.equal(output.reviews[0].status, "closed");
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

    assert.equal(output.reviews[0].status, "posted");
    assert.deepEqual(
      labelWrites().map((call) => call.slice(2)),
      [
        [
          "DELETE",
          "repos/acme/shop/issues/7/labels/reviewbot-review%3Asimplify",
        ],
        [
          "POST",
          "repos/acme/shop/issues/7/labels",
          "-f",
          "labels[]=reviewbot-review:simplify",
        ],
      ],
    );
  });

  test("takes the repository and number from a pull request URL", async () => {
    writeState({ outcomes: { "reviewbot-review:simplify": [{ review: {} }] } });

    const result = await runScript("ship-it-review-run.mjs", [
      "https://github.com/acme/shop/pull/7",
      "reviewbot-review:simplify",
      ...FAST,
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).repository, "acme/shop");
    assert.equal(
      ghCalls().some((call) => call.includes("repos/{owner}/{repo}")),
      false,
    );
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

    const result = await runScript("ship-it-review-run.mjs", [
      "7",
      "reviewbot-review:simplify",
      ...FAST,
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      [...new Set(ghCalls().map(([command]) => command))],
      ["api"],
    );
  });

  test("refuses a closed pull request", async () => {
    writeState({
      pr: { number: 7, state: "MERGED", headRefOid: HEAD, labels: [] },
    });

    const result = await runScript("ship-it-review-run.mjs", [
      "7",
      "reviewbot-review:simplify",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Pull request #7 on acme\/shop is merged/);
    assert.deepEqual(labelWrites(), []);
  });

  test("refuses a label the repository does not have", async () => {
    writeState();

    const result = await runScript("ship-it-review-run.mjs", [
      "7",
      "reviewbot-review:security",
    ]);

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /The label reviewbot-review:security does not exist on acme\/shop/,
    );
  });

  test("refuses a label that requests no review", async () => {
    writeState();

    const result = await runScript("ship-it-review-run.mjs", ["7", "bug"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /bug is not a review label/);
  });

  test("refuses a negative retry count", async () => {
    writeState();

    const result = await runScript("ship-it-review-run.mjs", [
      "7",
      "reviewbot-review:simplify",
      "--retries",
      "-1",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--retries option needs a whole number/);
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

    assert.equal(output.reviews[0].status, "posted");
    assert.equal(output.reviews[0].attempts, 1);
    assert.notEqual(output.reviews[0].review_id, 1);
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

    assert.equal(output.reviews[0].status, "posted");
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

    assert.equal(output.reviews[0].status, "posted");
    assert.equal(output.reviews[0].attempts, 1);
  });

  test("reports a head that moved as the review posted", async () => {
    writeState({
      outcomes: {
        "reviewbot-review:simplify": [{ review: {}, headMovesTo: OTHER_HEAD }],
      },
    });

    const output = await runReviews(["reviewbot-review:simplify"]);

    assert.equal(output.reviews[0].status, "posted");
    assert.equal(output.head, HEAD);
    assert.equal(output.head_moved_to, OTHER_HEAD);
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

    const listed = await runScript("ship-it-review-list.mjs", []);
    const output = await runReviews(["reviewbot-review:late"]);

    assert.deepEqual(
      JSON.parse(listed.stdout).map(({ label }) => label),
      ["reviewbot-review:late"],
    );
    assert.equal(output.reviews[0].status, "posted");
  });

  test("stops with an error when a gh call stalls", async () => {
    writeState();

    const result = await runScript(
      "ship-it-review-run.mjs",
      ["7", "reviewbot-review:simplify", ...FAST],
      { FAKE_GH_STALL_ON: "/reviews", SHIP_IT_GH_TIMEOUT_SECONDS: "0.5" },
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /did not answer within 0.5 seconds/);
  });

  test("points to the MCP reference when gh is missing", async () => {
    writeState();

    const result = await runScript(
      "ship-it-review-run.mjs",
      ["7", "reviewbot-review:simplify", ...FAST],
      { PATH: sandbox.root },
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unable to find the gh executable/);
    assert.match(result.stderr, /references\/github\.md/);
  });
});
