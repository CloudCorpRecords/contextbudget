# contextbudget

contextbudget estimates the token cost of a directory tree for an agent context window. It walks a tree, estimates the cost of every text file, compares the total against a budget, and reports the largest files and the subtrees that were skipped, so you can decide what to exclude before a tree eats the whole window.

## The estimator, honestly

The token numbers in this tool are a heuristic estimate, not a tokenizer count. contextbudget decodes each counted file as UTF-8 text and applies one deterministic rule: tokens = ceil(chars / 4), where chars is the length of the decoded text. Real tokenizers split text differently depending on the model, so a real tokenizer will give a different number for the same file, sometimes higher and sometimes lower. Use these numbers to compare files with each other, to rank the biggest offenders, and to check a tree against a rough budget. Do not use them as an exact prediction of what any specific model will charge or accept.

## Install

```sh
npx @reneturcios/contextbudget budget [path]
```

Or install it as a dependency of your own tooling and use the MCP server form below. The package requires Node 20 or newer.

## CLI usage

```sh
contextbudget budget [path] [--json]
contextbudget mcp
contextbudget --version
```

- `budget [path]`: check the tree at `path`, which defaults to the current directory. Prints a human readable report, or the full JSON report with `--json`.
- `mcp`: run the MCP server over stdio.
- `--version`: print the version.

Exit codes:

- 0: the verdict is WITHIN-BUDGET.
- 1: any other verdict, currently OVER-BUDGET.
- 2: usage error, or the target does not exist.
- 141: the reader closed the output pipe early (the shell visible equivalent of SIGPIPE).

### Budget

The default budget is 200000 estimated tokens. Set the environment variable `CONTEXTBUDGET_BUDGET` to a positive integer to use a different budget:

```sh
CONTEXTBUDGET_BUDGET=50000 contextbudget budget ./src
```

If the variable is unset, unparsable, or not positive, the default of 200000 applies.

## Verdict rules

- The verdict is WITHIN-BUDGET when the total estimated tokens are less than or equal to the budget, and OVER-BUDGET otherwise.
- The walk skips these directories by default and never descends into them: node_modules, .git, dist, coverage, .next, vendor.
- Files over 1 MiB (1048576 bytes) are skipped and not counted.
- Binary files, detected by a NUL byte in the first 4 KiB, are skipped and not counted.
- Symbolic links are not followed.

Findings:

- One high finding, rule `large-file`, for each counted file whose estimated tokens are over 10 percent of the budget.
- One medium finding, rule `skipped-large`, for each file skipped for exceeding the 1 MiB limit.
- One info finding, rule `skipped-dir`, for each directory skipped by the default skip list.

Ordering is deterministic: files are ranked by estimated tokens descending, then path ascending, and directory entries are visited in sorted name order. Reports carry no timestamps.

## Report shape

The JSON report has `tool`, `version`, `target`, `verdict`, `counts`, `findings`, and `summary`. The headline numbers live in `counts`:

- `files`: files counted.
- `totalTokens`: total estimated tokens across counted files.
- `totalChars`: total characters across counted files.
- `budgetTokens`: the budget in effect.
- `remainingTokens`: budget minus total, negative when over budget.
- `skippedDirs`, `skippedBinary`, `skippedLarge`: skip counts.
- `findings`, `findingsHigh`, `findingsMedium`, `findingsInfo`, `findingsLow`: finding counts.
- `ext:<extension>:files` and `ext:<extension>:tokens`: per extension totals, for example `ext:.ts:tokens`.
- `top:<relative path>`: estimated tokens for each of the top 10 largest files.

## MCP

The MCP server exposes one tool:

- `budget_path`: takes a `path` string and returns the same JSON report as `contextbudget budget <path> --json`.

Run it with `contextbudget mcp`, or through the registry entry in `server.json`.

## Limits

- Text files only: binary files and files over 1 MiB are skipped, so their real cost is invisible to the report except as skip counts and, for large files, medium findings.
- The estimator is a heuristic, as described above. It is not a tokenizer and does not know any specific model's vocabulary.
- The skip list is fixed. There is no flag or config file for custom skips or custom budgets per directory in this version; the only budget control is `CONTEXTBUDGET_BUDGET`.
- Counts reflect file contents only. File names, directory names, and any framing an agent harness adds around file contents are not estimated.

## Development

```sh
npm install
npm run build
npm test
```
