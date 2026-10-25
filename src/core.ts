/**
 * contextbudget core.
 *
 * Estimates the token cost of a directory tree for an agent context
 * window. The estimate is a deterministic heuristic: tokens equals
 * ceil(chars / 4) over the UTF-8 decoded text of each counted file.
 * It is not a tokenizer count and is never presented as one.
 *
 * The Report shape is fixed by src/types.ts, so the richer breakdowns
 * live in counts under stable keys:
 *   counts["ext:<ext>:files"]  and counts["ext:<ext>:tokens"]
 *     per extension totals, inserted sorted by tokens descending,
 *     then extension ascending.
 *   counts["top:<relative path>"]
 *     estimated tokens for each of the top 10 largest files, inserted
 *     sorted by tokens descending, then path ascending.
 * renderReport reads those keys back out of counts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { Finding, Report } from "./types.js";

export const VERSION = "0.1.0";
export const CLEAN_VERDICT = "WITHIN-BUDGET";
export const OVER_BUDGET_VERDICT = "OVER-BUDGET";
export const DEFAULT_BUDGET = 200000;
export const MAX_FILE_BYTES = 1024 * 1024;
export const TOP_FILE_LIMIT = 10;

export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".next",
  "vendor",
]);

interface CountedFile {
  rel: string;
  ext: string;
  chars: number;
  tokens: number;
}

function getBudget(): number {
  const raw = process.env.CONTEXTBUDGET_BUDGET;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_BUDGET;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function extensionOf(rel: string): string {
  const ext = extname(rel).toLowerCase();
  return ext === "" ? "(none)" : ext;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function runCheck(target: string): Report {
  if (!existsSync(target)) {
    throw new Error(`Target does not exist: ${target}`);
  }
  const budget = getBudget();
  const root = resolve(target);
  const rootStat = statSync(root);

  const counted: CountedFile[] = [];
  const findings: Finding[] = [];
  let skippedDirs = 0;
  let skippedBinary = 0;
  let skippedLarge = 0;

  function processFile(absPath: string, rel: string): void {
    const stat = statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) {
      skippedLarge += 1;
      findings.push({
        rule: "skipped-large",
        severity: "medium",
        file: rel,
        message: `File skipped: ${stat.size} bytes exceeds the 1048576 byte limit, so its token cost is not counted.`,
        evidence: `${stat.size} bytes`,
      });
      return;
    }
    const buffer = readFileSync(absPath);
    const probe = buffer.subarray(0, 4096);
    if (probe.includes(0)) {
      skippedBinary += 1;
      return;
    }
    const text = buffer.toString("utf8");
    const chars = text.length;
    const tokens = Math.ceil(chars / 4);
    counted.push({ rel, ext: extensionOf(rel), chars, tokens });
    if (tokens * 10 > budget) {
      findings.push({
        rule: "large-file",
        severity: "high",
        file: rel,
        message: `File uses an estimated ${tokens} tokens, over 10 percent of the ${budget} token budget. Consider excluding it or splitting it.`,
        evidence: `${tokens} tokens from ${chars} chars`,
      });
    }
  }

  function walk(dirAbs: string): void {
    const entries = readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) =>
      compareStrings(a.name, b.name),
    );
    for (const entry of entries) {
      const absPath = join(dirAbs, entry.name);
      const rel = toPosix(relative(root, absPath));
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skippedDirs += 1;
          findings.push({
            rule: "skipped-dir",
            severity: "info",
            file: rel,
            message: `Directory skipped by default: ${entry.name}. Its contents are not counted.`,
          });
          continue;
        }
        walk(absPath);
        continue;
      }
      if (entry.isFile()) {
        processFile(absPath, rel);
      }
    }
  }

  if (rootStat.isDirectory()) {
    walk(root);
  } else if (rootStat.isFile()) {
    processFile(root, basename(root));
  } else {
    throw new Error(`Target is not a file or directory: ${target}`);
  }

  const totalTokens = counted.reduce((sum, f) => sum + f.tokens, 0);
  const totalChars = counted.reduce((sum, f) => sum + f.chars, 0);
  const verdict = totalTokens <= budget ? CLEAN_VERDICT : OVER_BUDGET_VERDICT;

  const sortedFiles = [...counted].sort(
    (a, b) => b.tokens - a.tokens || compareStrings(a.rel, b.rel),
  );
  const topFiles = sortedFiles.slice(0, TOP_FILE_LIMIT);

  const byExt = new Map<string, { files: number; tokens: number }>();
  for (const f of counted) {
    const bucket = byExt.get(f.ext) ?? { files: 0, tokens: 0 };
    bucket.files += 1;
    bucket.tokens += f.tokens;
    byExt.set(f.ext, bucket);
  }
  const extRows = [...byExt.entries()].sort(
    (a, b) => b[1].tokens - a[1].tokens || compareStrings(a[0], b[0]),
  );

  const counts: Record<string, number> = {
    files: counted.length,
    totalTokens,
    totalChars,
    budgetTokens: budget,
    remainingTokens: budget - totalTokens,
    skippedDirs,
    skippedBinary,
    skippedLarge,
    findings: findings.length,
    findingsHigh: findings.filter((f) => f.severity === "high").length,
    findingsMedium: findings.filter((f) => f.severity === "medium").length,
    findingsInfo: findings.filter((f) => f.severity === "info").length,
    findingsLow: findings.filter((f) => f.severity === "low").length,
  };
  for (const [ext, bucket] of extRows) {
    counts[`ext:${ext}:files`] = bucket.files;
    counts[`ext:${ext}:tokens`] = bucket.tokens;
  }
  for (const f of topFiles) {
    counts[`top:${f.rel}`] = f.tokens;
  }

  const summary = `${counted.length} files, ${totalTokens} estimated tokens against a budget of ${budget} tokens: ${verdict}`;

  return {
    tool: "contextbudget",
    version: VERSION,
    target,
    verdict,
    counts,
    findings,
    summary,
  };
}

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

export function renderReport(report: Report): string {
  const counts = report.counts;
  const num = (key: string): number => counts[key] ?? 0;

  const topRows = Object.entries(counts)
    .filter(([key]) => key.startsWith("top:"))
    .map(([key, tokens]) => ({ path: key.slice("top:".length), tokens }))
    .sort((a, b) => b.tokens - a.tokens || compareStrings(a.path, b.path));

  const extMap = new Map<string, { files: number; tokens: number }>();
  for (const [key, value] of Object.entries(counts)) {
    if (!key.startsWith("ext:")) continue;
    const rest = key.slice("ext:".length);
    if (rest.endsWith(":files")) {
      const ext = rest.slice(0, -":files".length);
      const bucket = extMap.get(ext) ?? { files: 0, tokens: 0 };
      bucket.files = value;
      extMap.set(ext, bucket);
    } else if (rest.endsWith(":tokens")) {
      const ext = rest.slice(0, -":tokens".length);
      const bucket = extMap.get(ext) ?? { files: 0, tokens: 0 };
      bucket.tokens = value;
      extMap.set(ext, bucket);
    }
  }
  const extRows = [...extMap.entries()].sort(
    (a, b) => b[1].tokens - a[1].tokens || compareStrings(a[0], b[0]),
  );

  const lines: string[] = [];
  lines.push(`contextbudget ${report.version}`);
  lines.push(`Target: ${report.target}`);
  lines.push(`Verdict: ${report.verdict}`);
  lines.push(`Summary: ${report.summary}`);
  lines.push("");
  lines.push("Totals:");
  lines.push(`  Files counted: ${num("files")}`);
  lines.push(`  Estimated tokens: ${num("totalTokens")}`);
  lines.push(`  Characters counted: ${num("totalChars")}`);
  lines.push(`  Budget: ${num("budgetTokens")} tokens`);
  lines.push(`  Remaining: ${num("remainingTokens")} tokens`);
  lines.push(`  Skipped directories: ${num("skippedDirs")}`);
  lines.push(`  Skipped binary files: ${num("skippedBinary")}`);
  lines.push(`  Skipped large files: ${num("skippedLarge")}`);
  lines.push("");
  lines.push("Per-extension totals:");
  if (extRows.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [ext, bucket] of extRows) {
      lines.push(
        `  ${ext}: ${bucket.files} ${plural(bucket.files, "file", "files")}, ${bucket.tokens} ${plural(bucket.tokens, "token", "tokens")}`,
      );
    }
  }
  lines.push("");
  lines.push("Top files by estimated tokens:");
  if (topRows.length === 0) {
    lines.push("  (none)");
  } else {
    topRows.forEach((row, i) => {
      lines.push(`  ${i + 1}. ${row.path}: ${row.tokens} ${plural(row.tokens, "token", "tokens")}`);
    });
  }
  lines.push("");
  lines.push("Findings:");
  if (report.findings.length === 0) {
    lines.push("  (none)");
  } else {
    for (const f of report.findings) {
      const where = f.file ? ` ${f.file}` : "";
      lines.push(`  [${f.severity}] ${f.rule}${where}: ${f.message}`);
    }
  }
  return lines.join("\n");
}
