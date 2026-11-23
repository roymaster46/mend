# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/roymaster46/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/roymaster46/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format: `mend` reads a patch from a file or standard input and applies it to the tree, or applies nothing at all when any edit fails.

```sh
node main.ts [options] [PATCH]
```

It understands four formats and picks the right one on its own: unified diffs (even when the model drifted the line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON edits (one array, or one object a line). A unified hunk lands on the occurrence nearest the number the patch names; a SEARCH/REPLACE block that matches twice is refused rather than guessed at; a V4A chunk follows its anchor and its cursor. Every edit is checked for safety first — a path that escapes the tree is never touched — and when any edit fails, no file is written at all, though the edits after it still run so every failure is reported.

## Options

- `--format=NAME` — `auto` (the default), `unified`, `search-replace`, `v4a`, or `json`.
- `--check` — report what would change without writing anything.
- `--strict` — exact matches only, no trailing- or surrounding-whitespace forgiveness.
- `--` — ends the options; a lone `-` reads the patch from standard input.

Exit 0 lists the changed files (`A`, `D`, `M`, or `R old -> new`, sorted by path) and `ok: <n> files`; exit 1 lists each failed edit and `failed: <k> of <n> edits`; exit 2 is a usage, missing-patch, format, or parse error, one line, nothing written.

## Run it

```sh
node main.ts fix.patch
cat fix.patch | node main.ts -
node main.ts --check --format=v4a patch.txt
```

Node 22, standard library alone. `runner.ts` beside it is the kit's trial runner, kept as it is.

---

<sub>Entered on [make.fun](https://make.fun/?ref=26tnw136&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
