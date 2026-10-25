/**
 * Core tests for contextbudget.
 *
 * Fixture token math, computed by hand from the fixture bytes
 * (tokens = ceil(chars / 4), fixtures written with no trailing newline):
 *
 *   fixtures/small/a.txt      "hello world"  11 chars, 3 tokens
 *   fixtures/small/b.md       "abcd"          4 chars, 1 token
 *   fixtures/small/sub/c.txt  "abcdefghij"   10 chars, 3 tokens
 *   small totals: 3 files, 25 chars, 7 tokens
 *
 *   fixtures/with-skips/index.txt  "12345678"  8 chars, 2 tokens
 *   The with-skips tree is generated at test time: the committed
 *   index.txt and dist files are copied into a temp dir, and a
 *   node_modules/pkg/big.txt file ("xxxxxxxxxx", 10 chars) is created
 *   there programmatically. A committed directory named node_modules
 *   cannot survive a push and checkout round trip, so no test may
 *   depend on one. Both node_modules and dist are skipped by default,
 *   so their contents never reach the totals.
 *
 *   Empty-directory tests also use a temp dir created at test time,
 *   because an empty directory cannot be stored by version control.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck, renderReport, CLEAN_VERDICT, VERSION } from "../src/core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SMALL = join(HERE, "fixtures", "small");
const WITH_SKIPS = join(HERE, "fixtures", "with-skips");

/** Build the with-skips tree in a temp dir, creating node_modules at test time. */
function makeWithSkipsTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "contextbudget-skips-"));
  cpSync(WITH_SKIPS, dir, { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pkg", "big.txt"), "xxxxxxxxxx", "utf8");
  return dir;
}

/** Create an empty directory at test time. */
function makeEmptyTree(): string {
  return mkdtempSync(join(tmpdir(), "contextbudget-empty-"));
}

function withBudget<T>(budget: string | undefined, fn: () => T): T {
  const saved = process.env.CONTEXTBUDGET_BUDGET;
  try {
    if (budget === undefined) {
      delete process.env.CONTEXTBUDGET_BUDGET;
    } else {
      process.env.CONTEXTBUDGET_BUDGET = budget;
    }
    return fn();
  } finally {
    if (saved === undefined) {
      delete process.env.CONTEXTBUDGET_BUDGET;
    } else {
      process.env.CONTEXTBUDGET_BUDGET = saved;
    }
  }
}

describe("runCheck on the small fixture tree", () => {
  it("counts exact hand-computed totals", () => {
    const r = withBudget(undefined, () => runCheck(SMALL));
    assert.equal(r.tool, "contextbudget");
    assert.equal(r.version, VERSION);
    assert.equal(r.target, SMALL);
    assert.equal(r.verdict, CLEAN_VERDICT);
    assert.equal(r.verdict, "WITHIN-BUDGET");
    assert.equal(r.counts.files, 3);
    assert.equal(r.counts.totalChars, 25);
    assert.equal(r.counts.totalTokens, 7);
    assert.equal(r.counts.budgetTokens, 200000);
    assert.equal(r.counts.remainingTokens, 200000 - 7);
    assert.equal(r.counts.skippedDirs, 0);
    assert.equal(r.counts.skippedBinary, 0);
    assert.equal(r.counts.skippedLarge, 0);
    assert.equal(r.counts.findings, 0);
    assert.equal(r.findings.length, 0);
    assert.match(r.summary, /7 estimated tokens/);
  });

  it("reports per-extension totals in counts", () => {
    const r = withBudget(undefined, () => runCheck(SMALL));
    assert.equal(r.counts["ext:.txt:files"], 2);
    assert.equal(r.counts["ext:.txt:tokens"], 6);
    assert.equal(r.counts["ext:.md:files"], 1);
    assert.equal(r.counts["ext:.md:tokens"], 1);
  });

  it("orders top files by tokens descending, then path ascending", () => {
    const r = withBudget(undefined, () => runCheck(SMALL));
    const topKeys = Object.keys(r.counts).filter((k) => k.startsWith("top:"));
    assert.deepEqual(topKeys, ["top:a.txt", "top:sub/c.txt", "top:b.md"]);
    assert.equal(r.counts["top:a.txt"], 3);
    assert.equal(r.counts["top:sub/c.txt"], 3);
    assert.equal(r.counts["top:b.md"], 1);
  });

  it("flips the verdict when a small env budget is exceeded", () => {
    const r = withBudget("5", () => runCheck(SMALL));
    assert.equal(r.verdict, "OVER-BUDGET");
    assert.equal(r.counts.budgetTokens, 5);
    assert.equal(r.counts.totalTokens, 7);
    assert.equal(r.counts.remainingTokens, -2);
  });

  it("emits one high finding per file over 10 percent of the budget", () => {
    const r = withBudget("5", () => runCheck(SMALL));
    const high = r.findings.filter((f) => f.severity === "high");
    assert.equal(high.length, 3);
    assert.ok(high.every((f) => f.rule === "large-file"));
    assert.deepEqual(
      high.map((f) => f.file).sort(),
      ["a.txt", "b.md", "sub/c.txt"],
    );
    assert.equal(r.counts.findingsHigh, 3);
  });

  it("stays within budget when the total equals the budget exactly", () => {
    const r = withBudget("7", () => runCheck(SMALL));
    assert.equal(r.verdict, CLEAN_VERDICT);
  });

  it("ignores an unparsable env budget and uses the default", () => {
    const r = withBudget("not-a-number", () => runCheck(SMALL));
    assert.equal(r.counts.budgetTokens, 200000);
  });

  it("checks a single file target", () => {
    const r = withBudget(undefined, () => runCheck(join(SMALL, "a.txt")));
    assert.equal(r.counts.files, 1);
    assert.equal(r.counts.totalTokens, 3);
    assert.equal(r.counts["top:a.txt"], 3);
  });

  it("throws for a missing target", () => {
    assert.throws(() => runCheck(join(HERE, "fixtures", "does-not-exist")), /does not exist/);
  });
});

describe("runCheck skips", () => {
  it("skips node_modules and dist and reports info findings for them", () => {
    const dir = makeWithSkipsTree();
    try {
      const r = withBudget(undefined, () => runCheck(dir));
      assert.equal(r.counts.files, 1);
      assert.equal(r.counts.totalChars, 8);
      assert.equal(r.counts.totalTokens, 2);
      assert.equal(r.counts.skippedDirs, 2);
      const infos = r.findings.filter((f) => f.severity === "info");
      assert.equal(infos.length, 2);
      assert.ok(infos.every((f) => f.rule === "skipped-dir"));
      assert.deepEqual(
        infos.map((f) => f.file).sort(),
        ["dist", "node_modules"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts an empty directory as zero with a clean verdict", () => {
    const dir = makeEmptyTree();
    try {
      const r = withBudget(undefined, () => runCheck(dir));
      assert.equal(r.counts.files, 0);
      assert.equal(r.counts.totalTokens, 0);
      assert.equal(r.counts.totalChars, 0);
      assert.equal(r.verdict, CLEAN_VERDICT);
      assert.equal(r.findings.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips binary files and files over 1 MiB in a generated tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "contextbudget-core-"));
    try {
      writeFileSync(join(dir, "small.txt"), "abcd", "utf8");
      writeFileSync(join(dir, "binary.bin"), Buffer.from([0x61, 0x00, 0x62, 0x63]));
      writeFileSync(join(dir, "large.txt"), "a".repeat(1024 * 1024 + 1), "utf8");
      const r = withBudget(undefined, () => runCheck(dir));
      assert.equal(r.counts.files, 1);
      assert.equal(r.counts.totalTokens, 1);
      assert.equal(r.counts.skippedBinary, 1);
      assert.equal(r.counts.skippedLarge, 1);
      const medium = r.findings.filter((f) => f.severity === "medium");
      assert.equal(medium.length, 1);
      assert.equal(medium[0]?.rule, "skipped-large");
      assert.equal(medium[0]?.file, "large.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderReport", () => {
  it("renders verdict, totals, top files, and findings deterministically", () => {
    const r = withBudget("5", () => runCheck(SMALL));
    const text = renderReport(r);
    assert.match(text, /Verdict: OVER-BUDGET/);
    assert.match(text, /Files counted: 3/);
    assert.match(text, /Estimated tokens: 7/);
    assert.match(text, /Budget: 5 tokens/);
    const aIdx = text.indexOf("1. a.txt: 3 tokens");
    const cIdx = text.indexOf("2. sub/c.txt: 3 tokens");
    const bIdx = text.indexOf("3. b.md: 1 token");
    assert.ok(aIdx >= 0 && cIdx > aIdx && bIdx > cIdx, "top files must be in sorted order");
    assert.match(text, /\[high\] large-file a\.txt:/);
    assert.equal(renderReport(r), text, "rendering the same report twice must be identical");
  });

  it("renders empty sections for an empty tree", () => {
    const dir = makeEmptyTree();
    try {
      const r = withBudget(undefined, () => runCheck(dir));
      const text = renderReport(r);
      assert.match(text, /Verdict: WITHIN-BUDGET/);
      assert.match(text, /Top files by estimated tokens:\n {2}\(none\)/);
      assert.match(text, /Findings:\n {2}\(none\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
