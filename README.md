[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/newmrd0003-create/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/newmrd0003-create/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`main.ts` is a Node 22, stdlib-only CLI that applies AI edits in four formats to a tree of text files, per `SPEC.md`:

- **unified diff** — `diff --git`, `---`/`+++`, hunks with line numbers that may be wrong; nearest-occurrence matching with drift, create/delete/move, `\ No newline at end of file`
- **SEARCH/REPLACE** — `<<<<<<< SEARCH` blocks with an optional path line, blocks inherit the previous block's path
- **V4A** — `*** Begin Patch` / `*** Add|Delete|Update File`, anchors, cursor-ordered chunks, `*** End of File`, `*** Move to:`
- **JSON** — one JSON object or array per patch, or one object per line (JSONL): `create`, `str_replace`, `insert`, `delete`

Matching is three-tier (exact, trailing-whitespace-insensitive, re-indented) as the spec defines, edits run in patch order and each edit sees the previous edits' results, a failed edit changes nothing, and nothing is written when any edit fails. `--check` reports the same changes without writing files.

## Usage

```sh
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

PATCH defaults to stdin; `-` also reads stdin. Exit 0 with `A`/`M`/`D`/`R` lines and `ok: N files`; exit 1 lists each failed edit (`error: <code> <path>`) then `failed: k of n edits`; exit 2 is a usage, format, parse, or no-patch error.

## Verification

- Practice set from the competition kit: **100 of 100 passed, practice score 1000** (`node check.ts <kit>/program/generator/practice.json`).
- 62 additional edge cases written from SPEC.md sentences the practice set does not cover (usage precedence, final-break handling, overlapping occurrences, drift, cursor order, EOF chunks, Move to, JSON faults, atomicity): **62 passed, 0 failed**.

`runner.ts`, `check.ts`, and `SPEC.md` are copied verbatim from the competition kit; `main.ts` is written from scratch against the spec.
