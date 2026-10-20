# Data Plan

## Context provenance
- `直接做真数据版：在云端跑一个真的代码映射循环，仪表盘实时显示` (verbatim build request; the loop must execute for real server-side, not an animation)
- `真数据版的意思是：我在云端 VM 上真的跑一个和图里一样的循环——拿一个代码仓库，agent 按 READ → EXTRACT → VERIFY 一轮轮扫，把抽出的规则、验证进度、模块状态实时写进这个仪表盘` (assistant explanation in parent conversation, accepted by the user's choice of 真数据版)
- User's reference screenshots: REA-agent loop HUD (loops / rules found / verified % / mismatches / wall clock, READ→EXTRACT→VERIFY→FIX pipeline, module grid, stop-condition box, session log) and Graphify graph (module nodes, EXTRACTED solid vs INFERRED dashed edges) — these define the HUD layout to reproduce with real data.
- User's GitHub has `motortrust` repos (from memory) but no specific repo was named for this run, so the dashboard takes any public `owner/repo` + subpath as user input, with fastapi/fastapi as the default target (the repo in the user's own Graphify screenshot).

## Tested sources
### GitHub REST API (api.github.com) — real code source for the loop
**Used by**: `startRun` (tree/contents listing → modules), `stepRun` (per-file contents fetch → READ/EXTRACT/VERIFY)
**Test command**: `curl -sL "https://api.github.com/repos/fastapi/fastapi/contents/fastapi?ref=master"` and probe-ctx fetch of `contents/fastapi/routing.py`
**Sample output**: contents listing returned real entries (`applications.py` 185155 bytes, `routing.py`, `dependencies/` dir, …); probe fetch returned status 200, base64 `content` decoding to real source (`import contextlib` first line), regex count found 44 top-level `def`/`class` in routing.py.
**Processing**: Follow redirects (repo moved tiangolo→fastapi). Group tree entries by top-level segment under the chosen subpath → modules. Per file: base64-decode contents (skip >120KB, log the skip), deterministic regex extraction (imports, `def`/`class`, decorators/routes) = rules; VERIFY cross-checks each internal import against the fetched file set and each extracted symbol against its source text → verified or mismatch. Edges: import present in source = EXTRACTED; symbol referenced without import = INFERRED.

## Long-term data behavior
- **Refresh policy**: No cron. A run executes only when the user presses Start; the client polls `getRunState` ~every 800ms while a run is active and drives `stepRun` (one module per call) so progress is genuinely incremental and visible.
- **Growth**: Each run inserts modules/rules/logs rows; starting a new run deletes the previous run's rows (single active run + last completed run retained for the rules list/graph).
- **Ordering**: Logs chronological by id; modules by path; rules by module then name.
- **Time semantics**: Wall clock computed from run `started_at` (server timestamp) to now/last step; log timestamps are server instants rendered viewer-local.

## Rejected approaches
- **Tried**: LLM-based rule extraction via `ctx.inference.complete`
  **Why rejected**: Probe showed it requires a Zod schema and adds latency/failure modes per file; deterministic parsing (like Graphify's tree-sitter, no-LLM) is faster, reproducible, and honestly labeled EXTRACTED. Inference not used.
- **Tried**: `raw.githubusercontent.com` file fetch via curl
  **Why rejected**: Timed out in shell probe; the GitHub Contents API (base64) worked reliably in both curl and the ctx probe, so all file reads go through `api.github.com`.
