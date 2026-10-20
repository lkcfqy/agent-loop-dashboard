# Agent Loop Dashboard

A dark neon **Mission Control / HUD-style dashboard** that visualizes a real AI agent
loop mapping a codebase — live, not simulated.

Enter any public GitHub repository and hit **START LOOP**. The server downloads the
repo tarball and runs a real 3-loop mapping cycle:

1. **READ → EXTRACT** — parses each module and extracts rules (imports, function and
   class definitions, routes) with real `file:line` citations
2. **VERIFY** — cross-checks imported symbols against their definitions across modules
3. **FIX** — deep re-check pass over everything that failed verification

The loop stops when every rule is verified with 0 mismatches, or after 3 loops, and
the stop-condition verdict is reported honestly (MET or NOT MET).

## What you see

- Header stats: LOOPS · RULES FOUND · VERIFIED % · MISMATCHES · WALL CLOCK
- READ → EXTRACT → VERIFY → FIX phase pipeline
- `rules.md` panel with per-rule status
- Module status grid (queued / active / verifying / fixed / done)
- Force-directed import graph — EXTRACTED edges solid, INFERRED edges dashed
- Stop-condition monitor and a streaming session log

## Stack

- React 19 + Tailwind CSS 4 (client)
- Bun + TypeScript server actions, Drizzle ORM over SQLite
- Built as a [Muse](https://muse.ai) space (full-stack artifact); the server layer
  uses `@hatch/space-sdk`, so running it standalone requires that runtime.

## Layout

- `client/` — HUD frontend (`src/App.tsx` is the dashboard)
- `server/` — loop engine and data actions (`src/actions.ts`, `src/schema.ts`)
- `drizzle/` — database migrations
