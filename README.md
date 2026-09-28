# pi-token-usage

A [pi](https://github.com/badlogic/pi-mono) extension for lifetime token usage tracking and cost analytics across all sessions.

Pi already shows token usage per session. `pi-token-usage` adds a cross-session view so you can answer questions like:
- how much have I spent in total?
- which models cost me the most?
- what did I use today, this week, or this month?
- which projects and sessions are driving usage?

## Features

- **Lifetime totals** — tokens, cost, and cache usage across all sessions
- **Time rollups** — today, last 7 days, last 30 days, and by month
- **Per-model breakdown** — usage grouped by provider/model
- **Per-project breakdown** — usage grouped by working directory
- **Per-session breakdown** — top sessions by cost
- **Live footer status** — today's project and total consumption in the footer
- **Customizable footer** — enable/disable it, choose metrics, style, separators, presets, or a full template override
- **Shared incremental index** — reconcile new/changed JSONL in a worker; unchanged transcript bodies are not reread
- **Simple commands** — query usage directly from pi with `/usage ...`

## Install

Install this fork (not the upstream npm package) with Pi `^0.87.1`:

```bash
pi install git:github.com/cartwmic/pi-token-usage
```

## Commands

```text
/usage                 — summary: lifetime, this month, last 30d, last 7d, today
/usage models          — breakdown by provider/model
/usage days [N]        — daily rollup for last N days (default: 7)
/usage months          — monthly rollup
/usage sessions [N]    — top N sessions by cost (default: 20)
/usage projects        — breakdown by project
/usage footer                     — show footer config and available items
/usage footer on|off              — enable or disable the footer
/usage footer items …             — choose footer items to show
/usage footer preset <name>       — apply a footer ordering preset
/usage footer separator <text>    — set the footer separator
/usage footer style <name>        — set footer styling (`plain`, `muted`, `cost`)
/usage footer template <text>     — override the full footer with a template
/usage footer untemplate          — remove the footer template override
/usage footer vars                — show available template variables
/usage footer reset               — remove project footer config
/usage refresh         — reconcile the current session tree now (bounded wait)
/usage help            — show command help
```

Aliases:

```text
/usage ?
/usage --help
```

## Example output

```text
── Token Usage ──
Period         Input     Output   Cache R   Cache W   Cost
Lifetime       1.2M      94.3k    3.4M      210.0k    $12.48
This month     240.0k    18.2k    640.0k    42.0k     $2.11
Last 30 days   310.5k    24.8k    811.0k    58.0k     $2.87
Last 7 days    84.1k     7.1k     210.4k    12.0k     $0.76
Today          9.2k      802      21.3k     0         $0.08
```

You can then drill down with `/usage models`, `/usage sessions`, `/usage projects`, or `/usage days 30`.

## Footer

By default, the extension adds a footer status with:
- today's current-project cost
- today's total cost across all projects

You can customize it per project:

```text
/usage footer
/usage footer on
/usage footer off
/usage footer items projectTodayCost,totalTodayCost
/usage footer items projectTodayTokens,totalTodayTokens
/usage footer preset summary
/usage footer preset full
/usage footer separator |
/usage footer style muted
/usage footer style cost
/usage footer template [project: {projectToday.cost} · {projectToday.tokens} tok]   [total: {totalToday.cost} · {totalToday.tokens} tok]
/usage footer untemplate
/usage footer vars
/usage footer reset
```

Available footer items:
- `projectTodayCost`
- `totalTodayCost`
- `projectTodayTokens`
- `totalTodayTokens`
- `projectTodaySummary`  — e.g. `Proj today $1.23 / 42K tok`
- `totalTodaySummary`    — e.g. `Total today $8.76 / 210K tok`

Available presets:
- `minimal`
- `costs`
- `tokens`
- `summary`
- `full`

Styling modes:
- `plain`  — no styling
- `muted`  — uses pi theme dim styling, matching the default footer more closely
- `cost`   — uses pi theme dim styling overall, with cost values colorized via the theme

Template variables use formatted values by default, with `Raw` variants for unformatted numbers.

Examples:
- `{projectToday.cost}` → `$2.56`
- `{projectToday.costRaw}` → `2.56`
- `{projectToday.tokens}` → `3.5M`
- `{projectToday.tokensRaw}` → `3521456`
- `{projectToday.summary}` → `$2.56 / 3.5M tok`
- same shape also exists for `totalToday`

Exact prompt example:

```text
/usage footer template [project: {projectToday.cost} · {projectToday.tokens} tok]   [total: {totalToday.cost} · {totalToday.tokens} tok]
```

Which renders like:

```text
[project: $2.56 · 3.5M tok]   [total: $12.50 · 32.3M tok]
```

Project-specific footer settings are stored in:

```text
<your-project>/.pi-token-usage.json
```

A global default config can also be placed at:

```text
~/.pi/agent/.pi-token-usage.json
```

## How it works

Pi's retained JSONL files under the active agent directory's `sessions/` tree are the source of truth (including nested child sessions). A worker incrementally reconciles recorded assistant, tool-result, standalone, compaction and branch-summary usage into a **derived**, rebuildable SQLite index at `<agent-dir>/token-usage-index-v1.sqlite`. It records file checkpoints/provenance and usage fields, not transcript content. Copied work counts once; unrelated entries sharing a short ID remain distinct. Sessions and projects use each canonical charge's source file and recorded cwd. Built-in compaction uses the selected branch model where known, otherwise appears under `unattributed` without dropping its tokens or cost. Day/month views use local calendar time.

A turn updates this window's footer immediately from a local overlay; worker writes, first backfill and metadata sweeps never block turn settlement. Other processes and child sessions reach an idle window on its periodic ~50-second sweep, not synchronously. A new window reuses the shared index. Loading, stale and incomplete views carry a visible warning rather than pretending partial totals are complete. Explicit `/usage` and `/usage refresh` attempt reconciliation with a 2.5-second bound; a timeout visibly warns that totals may be partial. Refresh does not force a full reread of unchanged files.

The index is disposable: stop Pi processes, remove `token-usage-index-v1.sqlite` and its `-wal`/`-shm` companions from the active agent directory, then start Pi and allow its JSONL backfill to finish. Keep the session JSONL files; deleting them removes their usage after a successful reconciliation.

## Notes

- Data stays local; no external service is used
- Results depend on usage metadata being present in pi session files
- Initial backfill may take time for a large session history; explicit commands warn if the catch-up bound expires
- The current agent directory only is indexed; archive directories, arbitrary `--session-dir` roots and ephemeral sessions without JSONL are not included
- This change was exercised on the personal machine with Pi 0.87.1, not on axon-work-computer; smoke-test the work host before deploying there

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) `^0.87.1` (Node with `node:sqlite` and worker-thread TypeScript support)

## Development

```bash
npm ci
npm test
npm run test:e2e  # real interactive Pi, Python 3 stdlib PTY and local scripted faux provider; no live API
```

## License

MIT
