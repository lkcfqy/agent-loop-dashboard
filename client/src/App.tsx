import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type State = ApiResponse<typeof api, "getState">;
type RunT = NonNullable<State["run"]>;
type ModuleT = State["modules"][number];
type RuleT = State["rules"][number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PRESETS = [
  { label: "fastapi/fastapi", repo: "fastapi/fastapi", branch: "master", subpath: "fastapi" },
  { label: "pallets/flask", repo: "pallets/flask", branch: "main", subpath: "src/flask" },
  { label: "expressjs/express", repo: "expressjs/express", branch: "master", subpath: "lib" },
  { label: "pallets/itsdangerous", repo: "pallets/itsdangerous", branch: "main", subpath: "src/itsdangerous" },
];

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

function statusColor(status: string): string {
  switch (status) {
    case "verified": return "var(--mint)";
    case "mismatch": return "var(--red)";
    case "reading": case "extracting": case "verifying": return "var(--accent)";
    case "error": return "var(--amber)";
    default: return "#54648f";
  }
}

// ---- force layout computed from the real edge list ----
// Forces are accumulated per node and each step is length-capped, so
// coincident nodes can never blow positions up to Infinity/NaN.
function layoutGraph(
  nodes: string[],
  edges: { fromModule: string; toModule: string }[],
): Map<string, { x: number; y: number }> {
  const W = 660, H = 430;
  const pos = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, nodes.length);
    pos.set(n, { x: W / 2 + Math.cos(a) * W * 0.34, y: H / 2 + Math.sin(a) * H * 0.34 });
  });
  const links = edges.filter((e) => pos.has(e.fromModule) && pos.has(e.toModule) && e.fromModule !== e.toModule);
  const fx = new Map<string, number>();
  const fy = new Map<string, number>();
  for (let iter = 0; iter < 200; iter++) {
    for (const n of nodes) { fx.set(n, 0); fy.set(n, 0); }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!; const b = nodes[j]!;
        const pa = pos.get(a)!; const pb = pos.get(b)!;
        let dx = pa.x - pb.x; let dy = pa.y - pb.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.5) {
          const ang = i * 2.399 + j;
          dx = Math.cos(ang); dy = Math.sin(ang); d = 0.5;
        }
        const rep = 5200 / (d * d);
        const ux = dx / d; const uy = dy / d;
        fx.set(a, (fx.get(a) ?? 0) + ux * rep);
        fy.set(a, (fy.get(a) ?? 0) + uy * rep);
        fx.set(b, (fx.get(b) ?? 0) - ux * rep);
        fy.set(b, (fy.get(b) ?? 0) - uy * rep);
      }
    }
    for (const e of links) {
      const pa = pos.get(e.fromModule)!; const pb = pos.get(e.toModule)!;
      const dx = pb.x - pa.x; const dy = pb.y - pa.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - 135) * 0.028;
      const ux = dx / d; const uy = dy / d;
      fx.set(e.fromModule, (fx.get(e.fromModule) ?? 0) + ux * f);
      fy.set(e.fromModule, (fy.get(e.fromModule) ?? 0) + uy * f);
      fx.set(e.toModule, (fx.get(e.toModule) ?? 0) - ux * f);
      fy.set(e.toModule, (fy.get(e.toModule) ?? 0) - uy * f);
    }
    for (const n of nodes) {
      const p = pos.get(n)!;
      let mx = fx.get(n) ?? 0; let my = fy.get(n) ?? 0;
      const len = Math.hypot(mx, my);
      const cap = 9;
      if (len > cap) { mx = (mx / len) * cap; my = (my / len) * cap; }
      p.x = Math.min(W - 46, Math.max(46, p.x + mx));
      p.y = Math.min(H - 26, Math.max(26, p.y + my));
    }
  }
  return pos;
}

function StatBox({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="rounded-md border px-2.5 py-2" style={{ borderColor: color, background: "rgba(10,18,48,.72)" }}>
      <div className="text-[9px] tracking-[0.18em]" style={{ color: "var(--dim)" }}>{label}</div>
      <div className="mt-0.5 truncate text-base font-bold leading-tight" style={{ color }}>{value}</div>
      {sub ? <div className="truncate text-[9px]" style={{ color: "var(--dim)" }}>{sub}</div> : null}
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState({}),
    refetchInterval: 1000,
  });
  const data = state.data;
  const run: RunT | null = data?.run ?? null;
  const modules: ModuleT[] = data?.modules ?? [];
  const rules: RuleT[] = data?.rules ?? [];
  const edges = data?.edges ?? [];
  const logs = data?.logs ?? [];

  const [repo, setRepo] = useState(PRESETS[0]!.repo);
  const [branch, setBranch] = useState(PRESETS[0]!.branch);
  const [subpath, setSubpath] = useState(PRESETS[0]!.subpath);
  const [prompt, setPrompt] = useState("map this codebase — extract every rule, verify until all verified");
  const [ruleFilter, setRuleFilter] = useState<"all" | "verified" | "mismatch" | "pending">("all");
  const [selectedModule, setSelectedModule] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const logRef = useRef<HTMLDivElement | null>(null);
  const driveIdRef = useRef(0);

  const running = run?.status === "running";

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // drive the server loop one module at a time while running
  const runId = run?.id;
  useEffect(() => {
    if (!running || !runId) return;
    const myId = ++driveIdRef.current;
    let alive = true;
    (async () => {
      await sleep(500);
      while (alive && driveIdRef.current === myId) {
        try {
          const r = await api.stepRun({ runId });
          await queryClient.invalidateQueries({ queryKey: ["state"] });
          if (r.finished) break;
        } catch {
          await sleep(1500);
        }
        await sleep(380);
      }
    })();
    return () => { alive = false; };
  }, [running, runId, queryClient]);

  // auto-scroll log
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  const startMut = useMutation({
    mutationFn: () => api.startRun({ repo, branch, subpath, prompt }),
    onSuccess: () => {
      setSelectedModule(null);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const stopMut = useMutation({
    mutationFn: (id: number) => api.stopRun({ runId: id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const elapsed = run
    ? (run.finishedAt ? new Date(run.finishedAt).getTime() : now) - new Date(run.startedAt).getTime()
    : 0;
  const verifiedPct = run && run.totalRules > 0
    ? Math.round((run.verifiedRules / run.totalRules) * 1000) / 10
    : 0;

  const phaseIdx = useMemo(() => {
    if (!run) return -1;
    if (run.status === "done") return 4;
    switch (run.phase) {
      case "READ": return 0;
      case "EXTRACT": return 1;
      case "VERIFY": return 2;
      case "FIX": return 3;
      default: return 0;
    }
  }, [run]);

  const graphNodes = useMemo(() => modules.map((m) => m.name), [modules]);
  const graphPos = useMemo(() => layoutGraph(graphNodes, edges), [graphNodes, edges]);
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) {
      d.set(e.fromModule, (d.get(e.fromModule) ?? 0) + 1);
      d.set(e.toModule, (d.get(e.toModule) ?? 0) + 1);
    }
    return d;
  }, [edges]);

  const shownRules = rules.filter((r) => {
    if (selectedModule && r.moduleName !== selectedModule) return false;
    if (ruleFilter === "all") return true;
    if (ruleFilter === "verified") return r.status === "verified" || r.status === "fixed";
    return r.status === ruleFilter;
  });

  const phases = ["01 READ", "02 EXTRACT", "03 VERIFY", "04 FIX · RE-LOOP"];
  const inputCls = "w-full rounded-md border border-[var(--border)] bg-[#060d26] px-2.5 py-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]";

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto max-w-6xl px-3 pb-10 pt-3 sm:px-4">
        {/* ===== title strip ===== */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2">
          <h1 className="text-sm font-extrabold tracking-wide sm:text-base">
            <span style={{ color: "var(--accent2)" }}>ONE PROMPT</span>
            <span className="mx-1.5" style={{ color: "var(--dim)" }}>→</span>
            <span style={{ color: "var(--accent)" }}>CODE-MAP AGENT</span>{" "}
            <span style={{ color: "var(--mint)" }}>LOOP ⟳</span>
          </h1>
          <div className="flex items-center gap-1.5 text-[10px] tracking-[0.15em]">
            <span
              className={running ? "hud-live-dot inline-block h-2 w-2 rounded-full" : "inline-block h-2 w-2 rounded-full"}
              style={{
                background: running
                  ? "var(--accent)"
                  : run?.status === "done" && run.mismatches === 0
                    ? "var(--mint)"
                    : run?.status === "done"
                      ? "var(--red)"
                      : "#54648f",
              }}
            />
            <span style={{ color: run?.status === "done" && run.mismatches > 0 ? "var(--red)" : "var(--dim)" }}>
              {running
                ? "LOOP RUNNING"
                : run?.status === "done" && run.mismatches === 0
                  ? "LOOP COMPLETE · STOP MET"
                  : run?.status === "done"
                    ? "LOOP ENDED · STOP NOT MET"
                    : run?.status === "error"
                      ? "ERROR"
                      : run?.status === "stopped"
                        ? "STOPPED"
                        : "IDLE"}
            </span>
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[9px] tracking-wider" style={{ color: "var(--dim)" }}>
          <span><span style={{ color: "var(--accent2)" }}>■</span> 1 prompt</span>
          <span><span style={{ color: "var(--accent)" }}>■</span> agent · looping</span>
          <span><span style={{ color: "var(--mint)" }}>■</span> verified rule</span>
          <span><span style={{ color: "var(--red)" }}>■</span> mismatch → re-loop</span>
          <span className="ml-auto hidden sm:inline">real run · GitHub tarball → local parse · no LLM</span>
        </div>

        {/* ===== controls ===== */}
        <section aria-label="Loop controls" className="mt-3 rounded-lg border border-[var(--border)] p-3" style={{ background: "rgba(10,18,48,.55)" }}>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                aria-label={`Preset ${p.label}`}
                disabled={running}
                onClick={() => { setRepo(p.repo); setBranch(p.branch); setSubpath(p.subpath); }}
                className="rounded-full border px-2.5 py-1 text-[10px] disabled:opacity-40"
                style={{
                  borderColor: repo === p.repo ? "var(--accent)" : "var(--border)",
                  color: repo === p.repo ? "var(--accent)" : "var(--dim)",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-2 lg:grid-cols-[1.2fr_0.6fr_1fr_2fr]">
            <label className="block">
              <span className="mb-1 block text-[9px] tracking-[0.15em]" style={{ color: "var(--dim)" }}>REPO (OWNER/NAME)</span>
              <input aria-label="Repository owner and name" className={inputCls} value={repo} disabled={running} onChange={(e) => setRepo(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[9px] tracking-[0.15em]" style={{ color: "var(--dim)" }}>BRANCH</span>
              <input aria-label="Branch" className={inputCls} value={branch} disabled={running} onChange={(e) => setBranch(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[9px] tracking-[0.15em]" style={{ color: "var(--dim)" }}>SUBPATH</span>
              <input aria-label="Subpath to map" className={inputCls} value={subpath} disabled={running} onChange={(e) => setSubpath(e.target.value)} />
            </label>
            <label className="block col-span-2 lg:col-span-1">
              <span className="mb-1 block text-[9px] tracking-[0.15em]" style={{ color: "var(--dim)" }}>PROMPT · ONE PROMPT, LOOPS UNTIL STOP CONDITION</span>
              <input aria-label="Loop prompt" className={inputCls} value={prompt} disabled={running} onChange={(e) => setPrompt(e.target.value)} />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label="Start the mapping loop"
              disabled={running || startMut.isPending || !repo.trim()}
              onClick={() => startMut.mutate()}
              className="rounded-md px-4 py-2 text-xs font-bold tracking-wider disabled:opacity-40"
              style={{ background: "var(--accent)", color: "#03101c", boxShadow: "0 0 16px rgba(56,225,255,.35)" }}
            >
              {startMut.isPending ? "FETCHING REPO…" : running ? "LOOP RUNNING…" : "▶ START LOOP"}
            </button>
            {running && run ? (
              <button
                type="button"
                aria-label="Stop the loop"
                onClick={() => stopMut.mutate(run.id)}
                className="rounded-md border px-4 py-2 text-xs font-bold tracking-wider"
                style={{ borderColor: "var(--red)", color: "var(--red)" }}
              >
                ■ STOP
              </button>
            ) : null}
            {run ? (
              <span className="text-[10px]" style={{ color: "var(--dim)" }}>
                target: <a className="underline" style={{ color: "var(--accent)" }} href={`https://github.com/${run.repo}/tree/${run.branch}/${run.subpath}`} target="_blank" rel="noreferrer">{run.repo}@{run.branch}/{run.subpath}</a>
                {" "}· {run.totalFiles} files
              </span>
            ) : (
              <span className="text-[10px]" style={{ color: "var(--dim)" }}>选一个仓库，点 START LOOP — 循环会在云端真实下载并逐模块解析。</span>
            )}
          </div>
          {(startMut.data && !startMut.data.ok && startMut.data.error) || run?.status === "error" ? (
            <p className="mt-2 text-[11px]" style={{ color: "var(--red)" }}>
              {startMut.data?.error ?? run?.error}
            </p>
          ) : null}
        </section>

        {/* ===== stat strip ===== */}
        <section aria-label="Loop statistics" className="mt-3 grid grid-cols-3 gap-2 lg:grid-cols-5">
          <StatBox label="LOOPS" value={run ? `#${run.loop}` : "#0"} sub={run ? `max ${3}` : undefined} color="var(--accent)" />
          <StatBox label="RULES FOUND" value={run ? `${run.totalRules}` : "0"} sub="imports · defs · classes · routes" color="#aebadd" />
          <StatBox label="VERIFIED" value={run ? `${verifiedPct.toFixed(1)}%` : "0%"} sub={run ? `${run.verifiedRules}/${run.totalRules}` : undefined} color="var(--mint)" />
          <StatBox label="MISMATCHES" value={run ? `${run.mismatches}` : "0"} sub={run && run.fixedCount ? `${run.fixedCount} fixed` : "re-loop on mismatch"} color={run && run.mismatches > 0 ? "var(--red)" : "var(--accent)"} />
          <div className="col-span-3 lg:col-span-1">
            <StatBox label="WALL CLOCK" value={run ? fmtClock(elapsed) : "0m 00s"} sub={run ? new Date(run.startedAt).toLocaleTimeString() : undefined} color="var(--accent2)" />
          </div>
        </section>

        {/* ===== agent status + pipeline ===== */}
        <section aria-label="Agent status" className="mt-3 rounded-lg border border-[var(--accent)] p-3" style={{ background: "rgba(10,18,48,.72)", boxShadow: "0 0 14px rgba(56,225,255,.15)" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs">
              <span style={{ color: "var(--accent)" }}>◉ CODE-MAP agent</span>
              <span className="ml-2" style={{ color: "var(--dim)" }}>
                {running
                  ? `· ${run?.phase.toLowerCase()}${run?.currentModule ? ` ${run.currentModule}` : ""}`
                  : run?.status === "done" && run.mismatches === 0
                    ? "· done · stop condition met"
                    : run?.status === "done"
                      ? "· ended · stop condition not met"
                      : "· idle"}
              </span>
            </div>
            <div className="text-[10px]" style={{ color: "var(--dim)" }}>
              {rules.length} rules in db · {edges.length} edges
            </div>
          </div>
          {run ? (
            <p className="mt-1 truncate text-[11px]" style={{ color: "var(--dim)" }}>
              reads prompt: <span style={{ color: "var(--text)" }}>"{run.prompt}"</span>
            </p>
          ) : null}
          <div className="mt-3 grid grid-cols-4 items-center gap-1.5">
            {phases.map((p, i) => (
              <div key={p} className="flex items-center gap-1.5">
                <div
                  className="flex-1 rounded border px-1.5 py-1.5 text-center text-[9px] tracking-wider sm:text-[10px]"
                  style={{
                    borderColor: phaseIdx === i ? "var(--accent)" : phaseIdx > i ? "var(--mint)" : "var(--border)",
                    color: phaseIdx === i ? "var(--accent)" : phaseIdx > i ? "var(--mint)" : "var(--dim)",
                    background: phaseIdx === i ? "rgba(56,225,255,.08)" : "transparent",
                  }}
                >
                  {p}
                </div>
                {i < 3 ? <span style={{ color: "var(--dim)" }}>→</span> : null}
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-center text-[9px]" style={{ color: "var(--dim)" }}>
            ↺ loop again until {run ? run.totalRules : 0}/{run ? run.totalRules : 0} verified · {verifiedPct.toFixed(0)}%
          </p>
        </section>

        <div className="mt-3 grid gap-3 lg:grid-cols-[240px_1fr]">
          {/* ===== rules.md panel ===== */}
          <aside aria-label="Module index" className="rounded-lg border p-3" style={{ borderColor: "var(--mint)", background: "rgba(6,20,24,.55)" }}>
            <div className="text-center text-[11px] font-bold" style={{ color: "var(--mint)" }}>rules.md</div>
            <div className="text-center text-[9px]" style={{ color: "var(--dim)" }}>
              {run ? `${run.verifiedRules} verified · ${run.mismatches} mismatch` : "empty · loop not started"}
            </div>
            <ul className="mt-2 space-y-1">
              {modules.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    aria-label={`Module ${m.name}, ${m.rulesFound} rules`}
                    onClick={() => setSelectedModule(selectedModule === m.name ? null : m.name)}
                    className="flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-[11px]"
                    style={{
                      background: selectedModule === m.name ? "rgba(56,225,255,.12)" : "transparent",
                      color: "var(--text)",
                    }}
                  >
                    <span className="truncate">
                      <span style={{ color: statusColor(m.status) }}>·</span> {m.name}
                    </span>
                    <span style={{ color: m.mismatchCount ? "var(--red)" : "var(--dim)" }}>
                      {m.rulesFound ? `${m.rulesVerified}/${m.rulesFound}` : "—"}
                    </span>
                  </button>
                </li>
              ))}
              {modules.length === 0 ? (
                <li className="px-1.5 py-2 text-[11px]" style={{ color: "var(--dim)" }}>— no modules yet —</li>
              ) : null}
            </ul>
            <div className="mt-3 border-t border-[var(--border)] pt-2 text-[10px] leading-5" style={{ color: "var(--dim)" }}>
              <div className="flex justify-between"><span>loops</span><span style={{ color: "var(--text)" }}>{run?.loop ?? 0}</span></div>
              <div className="flex justify-between"><span>rules</span><span style={{ color: "var(--text)" }}>{run?.totalRules ?? 0}</span></div>
              <div className="flex justify-between"><span>verified</span><span style={{ color: "var(--mint)" }}>{run?.verifiedRules ?? 0}</span></div>
              <div className="flex justify-between"><span>fixed</span><span style={{ color: "var(--accent)" }}>{run?.fixedCount ?? 0}</span></div>
            </div>
          </aside>

          {/* ===== module grid ===== */}
          <section aria-label="Modules" className="grid content-start grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {modules.map((m) => {
              const active = run?.currentModule === m.name;
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-label={`Open module ${m.name}`}
                  onClick={() => setSelectedModule(selectedModule === m.name ? null : m.name)}
                  className={`rounded-md border p-2.5 text-left ${active ? "hud-scanning" : ""}`}
                  style={{
                    borderColor: statusColor(m.status),
                    background: "rgba(10,18,48,.72)",
                    outline: selectedModule === m.name ? "1px solid var(--accent)" : undefined,
                  }}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-[9px]" style={{ color: "var(--dim)" }}>{m.path}/</span>
                    <span className="shrink-0 text-[9px] tracking-wider" style={{ color: statusColor(m.status) }}>{m.status}</span>
                  </div>
                  <div className="mt-0.5 truncate text-sm font-bold">{m.name}</div>
                  <div className="mt-0.5 text-[10px]" style={{ color: "var(--dim)" }}>
                    {m.fileCount} files{m.rulesFound ? ` · ${m.rulesVerified}/${m.rulesFound} verified` : ""}
                    {m.mismatchCount ? <span style={{ color: "var(--red)" }}> · {m.mismatchCount} ✗</span> : null}
                  </div>
                </button>
              );
            })}
            {modules.length === 0 ? (
              <div className="col-span-full rounded-md border border-dashed border-[var(--border)] p-6 text-center text-xs" style={{ color: "var(--dim)" }}>
                模块网格是空的 — 启动循环后，这里会出现目标仓库的真实模块，一格一格被扫亮。
              </div>
            ) : null}
          </section>
        </div>

        {/* ===== stop condition ===== */}
        <section aria-label="Stop condition" className="mx-auto mt-3 max-w-xl rounded-lg border p-3 text-center" style={{ borderColor: "var(--accent2)", background: "rgba(20,14,54,.5)" }}>
          <div className="text-[10px] tracking-[0.2em]" style={{ color: "var(--accent2)" }}>
            stop check · every loop
          </div>
          <div className="mt-1 text-xs" style={{ color: "var(--text)" }}>
            until:{" "}
            <span style={{ color: run?.status === "done" && run.mismatches === 0 ? "var(--mint)" : "var(--text)" }}>
              {run?.verifiedRules ?? 0}/{run?.totalRules ?? 0} verified
            </span>{" "}
            · {run?.mismatches ?? 0} mismatches
            {run?.status === "done" ? (
              <span style={{ color: run.mismatches === 0 ? "var(--mint)" : "var(--red)" }}>
                {run.mismatches === 0 ? " · ■ MET" : " · ■ NOT MET (max loops)"}
              </span>
            ) : null}
          </div>
          <div className="mx-auto mt-2 h-1.5 max-w-md overflow-hidden rounded-full" style={{ background: "#131f4a" }}>
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${verifiedPct}%`, background: "var(--mint)" }} />
          </div>
        </section>

        {/* ===== graph ===== */}
        {modules.length > 0 ? (
          <section aria-label="Code graph" className="mt-3 rounded-lg border border-[var(--border)] p-3" style={{ background: "rgba(8,13,36,.8)" }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[11px] font-bold tracking-wider">
                graph · {run?.repo}/{run?.subpath}
              </h2>
              <div className="flex gap-3 text-[9px]" style={{ color: "var(--dim)" }}>
                <span>— EXTRACTED import</span>
                <span>- - INFERRED name reference</span>
                <span>点节点看该模块的规则</span>
              </div>
            </div>
            <svg viewBox="0 0 660 430" className="mt-1 w-full" role="img" aria-label="Module relationship graph built from real imports">
              {edges.map((e, i) => {
                const a = graphPos.get(e.fromModule); const b = graphPos.get(e.toModule);
                if (!a || !b || e.fromModule === e.toModule) return null;
                return (
                  <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={e.kind === "EXTRACTED" ? "#3d5a99" : "#5a4a8a"}
                    strokeWidth={e.kind === "EXTRACTED" ? 1.2 : 1}
                    strokeDasharray={e.kind === "EXTRACTED" ? undefined : "4 4"} opacity={0.8} />
                );
              })}
              {modules.map((m) => {
                const p = graphPos.get(m.name);
                if (!p) return null;
                const r = 6 + Math.min(9, (degree.get(m.name) ?? 0) * 1.3);
                const c = statusColor(m.status);
                return (
                  <g key={m.id} onClick={() => setSelectedModule(selectedModule === m.name ? null : m.name)} style={{ cursor: "pointer" }}>
                    <circle cx={p.x} cy={p.y} r={r + 4} fill="transparent" />
                    <circle cx={p.x} cy={p.y} r={r} fill={c} fillOpacity={0.25} stroke={c} strokeWidth={selectedModule === m.name ? 2.4 : 1.4} />
                    <text x={p.x} y={p.y + r + 12} textAnchor="middle" fontSize="9.5" fill="#b9cdf5">{m.name}</text>
                  </g>
                );
              })}
            </svg>
          </section>
        ) : null}

        {/* ===== rules list ===== */}
        {rules.length > 0 ? (
          <section aria-label="Extracted rules" className="mt-3 rounded-lg border border-[var(--border)] p-3" style={{ background: "rgba(10,18,48,.55)" }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[11px] font-bold tracking-wider">
                rules {selectedModule ? `· ${selectedModule}` : ""} ({shownRules.length})
              </h2>
              <div className="flex gap-1.5" role="group" aria-label="Filter rules by status">
                {(["all", "verified", "mismatch", "pending"] as const).map((f) => (
                  <button key={f} type="button" aria-label={`Filter ${f}`} aria-pressed={ruleFilter === f}
                    onClick={() => setRuleFilter(f)}
                    className="rounded-full border px-2 py-0.5 text-[10px]"
                    style={{
                      borderColor: ruleFilter === f ? "var(--accent)" : "var(--border)",
                      color: ruleFilter === f ? "var(--accent)" : "var(--dim)",
                    }}>
                    {f}
                  </button>
                ))}
                {selectedModule ? (
                  <button type="button" aria-label="Clear module selection" onClick={() => setSelectedModule(null)}
                    className="rounded-full border px-2 py-0.5 text-[10px]" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
                    ✕ {selectedModule}
                  </button>
                ) : null}
              </div>
            </div>
            <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto pr-1">
              {shownRules.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 rounded px-2 py-1 text-[11px]" style={{ background: "rgba(6,13,38,.6)" }}>
                  <span style={{ color: r.status === "verified" ? "var(--mint)" : r.status === "fixed" ? "var(--accent)" : r.status === "mismatch" ? "var(--red)" : "var(--amber)" }}>
                    {r.status === "verified" ? "✓" : r.status === "fixed" ? "✓fix" : r.status === "mismatch" ? "✗" : "…"}
                  </span>
                  <span className="font-bold">{r.name}</span>
                  <span className="rounded px-1 text-[9px]" style={{ background: "#16245c", color: "#9db4e8" }}>{r.kind}</span>
                  <span style={{ color: "var(--dim)" }}>{r.file}:{r.line}</span>
                  {r.detail ? <span className="w-full truncate text-[10px] sm:w-auto sm:flex-1" style={{ color: "var(--dim)" }}>{r.detail}</span> : null}
                </li>
              ))}
              {shownRules.length === 0 ? (
                <li className="px-2 py-3 text-[11px]" style={{ color: "var(--dim)" }}>该筛选下没有规则。</li>
              ) : null}
            </ul>
          </section>
        ) : null}

        {/* ===== session log ===== */}
        <section aria-label="Session log" className="mt-3">
          <div className="text-[10px] tracking-[0.2em]" style={{ color: "var(--dim)" }}>session log</div>
          <div ref={logRef} className="mt-1 h-52 overflow-y-auto rounded-md border border-[var(--border)] p-2.5 text-[11px] leading-5" style={{ background: "#050b22" }}>
            {logs.map((l) => (
              <div key={l.id} className="flex gap-2">
                <span className="shrink-0" style={{ color: "var(--dim)" }}>
                  {new Date(l.createdAt).toLocaleTimeString("en-GB")}
                </span>
                <span className="w-14 shrink-0 font-bold" style={{
                  color: l.phase === "error" || l.phase === "stop" ? "var(--red)" : l.phase === "verify" ? "var(--mint)" : l.phase === "fix" ? "var(--accent2)" : l.phase === "loop" ? "var(--accent2)" : "var(--accent)",
                }}>
                  {l.phase}
                </span>
                <span className="break-all">{l.message}</span>
              </div>
            ))}
            {logs.length === 0 ? (
              <div style={{ color: "var(--dim)" }}>— log is empty · start a loop —</div>
            ) : null}
            {running ? <div className="hud-live-dot" style={{ color: "var(--accent)" }}>▌</div> : null}
          </div>
        </section>

        {/* ===== footer status bar ===== */}
        <footer className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--border)] pt-2 text-[10px]" style={{ color: "var(--dim)" }}>
          <span>agent [loop <span style={{ color: "var(--accent)" }}>#{run?.loop ?? 0}</span>]</span>
          <span>phase [<span style={{ color: "var(--accent)" }}>{run?.phase.toLowerCase() ?? "idle"}</span>]</span>
          <span>rules [<span style={{ color: "var(--text)" }}>{run?.verifiedRules ?? 0}/{run?.totalRules ?? 0}</span>]</span>
          <span>verified [<span style={{ color: "var(--mint)" }}>{verifiedPct.toFixed(0)}%</span>]</span>
          <span>mismatch [<span style={{ color: run && run.mismatches ? "var(--red)" : "var(--text)" }}>{run?.mismatches ?? 0}</span>]</span>
          <span>wall [<span style={{ color: "var(--accent2)" }}>{fmtClock(elapsed)}</span>]</span>
          <span className="ml-auto">source: github.com/{run?.repo ?? "—"} · parsed locally, EXTRACTED/INFERRED labeled</span>
        </footer>
      </main>
    </div>
  );
}
