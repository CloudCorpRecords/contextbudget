/**
 * Pipe regression tests, following the fleet emit contract pattern.
 *
 * Node stdout attached to a pipe is asynchronous: console.log followed
 * by process.exit discards whatever the pipe has not drained, truncating
 * at one 64 KiB pipe buffer while the exit code still reports success.
 * These tests spawn the real CLI with piped stdio and push a report past
 * 200 KiB through the pipe.
 *
 * The generated tree holds many small files. A tiny budget arrives via
 * CONTEXTBUDGET_BUDGET, so every file is over 10 percent of the budget
 * and produces one high finding, which is what makes the JSON large.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runCheck, renderReport } from "../src/core.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE_COUNT = 1600;
const FILE_CHARS = 200;

let dir: string;
let savedBudget: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "contextbudget-pipe-"));
  savedBudget = process.env.CONTEXTBUDGET_BUDGET;
  process.env.CONTEXTBUDGET_BUDGET = "100";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedBudget === undefined) {
    delete process.env.CONTEXTBUDGET_BUDGET;
  } else {
    process.env.CONTEXTBUDGET_BUDGET = savedBudget;
  }
});

/** Many small text files: 200 chars each, 50 estimated tokens each. */
function writeBigTree(root: string, fileCount = FILE_COUNT): void {
  const body = "x".repeat(FILE_CHARS);
  for (let f = 0; f < fileCount; f++) {
    writeFileSync(join(root, `file${String(f).padStart(4, "0")}.txt`), body, "utf8");
  }
}

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { destroyStdoutOnFirstChunk?: boolean } = {}): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("CLI timed out"));
    }, 90000);
    if (opts.destroyStdoutOnFirstChunk) {
      // Close the read end immediately, before the child has even finished
      // computing its report. The report is far larger than one pipe
      // buffer, so the write cannot fully land before the close and the
      // writer must see EPIPE rather than a clean exit.
      child.stdout.destroy();
    }
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (opts.destroyStdoutOnFirstChunk) child.stdout.destroy();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectPromise(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout: out, stderr: err });
    });
  });
}

describe("emit contract: piped output is delivered whole", () => {
  it("piped --json report over 200 KiB parses and matches the in-process report", { timeout: 120000 }, async () => {
    writeBigTree(dir);
    const direct = runCheck(dir);
    assert.equal(direct.verdict, "OVER-BUDGET");
    assert.equal(direct.counts.files, FILE_COUNT);
    assert.equal(direct.counts.findings, FILE_COUNT);
    const directJson = JSON.stringify(direct, null, 2);
    assert.ok(directJson.length > 200_000, `fixture must exceed 200 KiB of JSON, got ${directJson.length}`);
    const res = await runCli(["budget", dir, "--json"]);
    assert.equal(res.code, 1, `expected exit 1 (OVER-BUDGET), got ${res.code} (stderr: ${res.stderr.slice(0, 200)})`);
    assert.equal(res.stdout.length, directJson.length + 1, "piped bytes must equal the full report plus the trailing newline");
    const parsed = JSON.parse(res.stdout) as { counts: { findings: number }; verdict: string };
    assert.equal(parsed.counts.findings, direct.counts.findings);
    assert.equal(parsed.verdict, direct.verdict);
  });

  it("piped human output is byte-identical to the in-process render", { timeout: 120000 }, async () => {
    writeBigTree(dir);
    const expected = renderReport(runCheck(dir)) + "\n";
    assert.ok(expected.length > 65_536, `human fixture must exceed one pipe buffer, got ${expected.length}`);
    const res = await runCli(["budget", dir]);
    assert.equal(res.code, 1);
    assert.equal(res.stdout, expected);
  });

  it("a reader that closes the pipe early never sees a success exit", { timeout: 120000 }, async () => {
    writeBigTree(dir);
    const res = await runCli(["budget", dir, "--json"], { destroyStdoutOnFirstChunk: true });
    assert.notEqual(res.code, 0, "exit 0 would report success for output that was never delivered");
    assert.ok(res.signal === "SIGPIPE" || res.code === 141, `expected SIGPIPE or exit 141, got code ${res.code} signal ${res.signal}`);
  });
});
