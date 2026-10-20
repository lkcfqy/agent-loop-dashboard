// Agent Loop Dashboard — a REAL code-mapping loop.
//
// startRun downloads the target repo tarball from GitHub (codeload, one
// request), gunzips + untars it server-side, stores every code file under
// the chosen subpath in the DB, and groups files into modules.
// stepRun processes ONE module per call through READ -> EXTRACT -> VERIFY
// (deterministic parsing: imports / defs / classes / route decorators),
// then loop 2 cross-verifies imported symbols against the defs actually
// extracted from the target modules, and loop 3 (FIX) re-reads the target
// modules' remaining files to resolve mismatches. The client drives
// stepRun repeatedly and polls getState, so the HUD shows genuine,
// incremental progress. Stop condition: every rule verified, or 3 loops.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, eq } from "drizzle-orm";
import { privileged } from "@space/privileged";
import * as schema from "./schema";

function getDb(ctx: Ctx) {
  return ctx.db<typeof schema>();
}
type Db = ReturnType<typeof getDb>;

const PASS1_FILES_PER_MODULE = 10;
const MAX_RULES_PER_MODULE = 400;
const MAX_LOOPS = 3;

// ---------- helpers ----------

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i).toLowerCase() : "";
}

function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function moduleOf(relPath: string): { name: string; path: string } {
  const segs = relPath.split("/").filter(Boolean);
  if (segs.length <= 1) {
    const f = segs[0] ?? relPath;
    return { name: stripExt(f), path: relPath };
  }
  return { name: segs[0] ?? relPath, path: segs.slice(0, 1).join("/") };
}

async function addLog(db: Db, runId: number, phase: string, message: string) {
  await db.insert(schema.logs).values({ runId, phase, message });
}

async function recomputeRun(db: Db, runId: number) {
  const all = await db
    .select()
    .from(schema.rules)
    .where(eq(schema.rules.runId, runId));
  const verified = all.filter(
    (r) => r.status === "verified" || r.status === "fixed",
  ).length;
  const mismatches = all.filter((r) => r.status === "mismatch").length;
  const fixed = all.filter((r) => r.status === "fixed").length;
  await db
    .update(schema.runs)
    .set({
      totalRules: all.length,
      verifiedRules: verified,
      mismatches,
      fixedCount: fixed,
    })
    .where(eq(schema.runs.id, runId));
  return { total: all.length, verified, mismatches, fixed };
}

async function refreshModuleCounts(db: Db, moduleId: number, runId: number, moduleName: string) {
  const rows = await db
    .select()
    .from(schema.rules)
    .where(eq(schema.rules.runId, runId));
  const mine = rows.filter((r) => r.moduleName === moduleName);
  await db
    .update(schema.modules)
    .set({
      rulesFound: mine.length,
      rulesVerified: mine.filter(
        (r) => r.status === "verified" || r.status === "fixed",
      ).length,
      mismatchCount: mine.filter((r) => r.status === "mismatch").length,
    })
    .where(eq(schema.modules.id, moduleId));
}

// ---------- fetched files (via privileged tarball download) ----------

type FetchedFile = { path: string; size: number; content: string | null };

// ---------- extraction ----------

type RawRule = {
  name: string;
  kind: string;
  file: string;
  line: number;
  detail: string;
  scope: string;
};

function extractFromFile(path: string, text: string): RawRule[] {
  const rules: RawRule[] = [];
  const lines = text.split("\n");
  const ext = extOf(path);
  let pendingDecorators: string[] = [];
  // Python class-scope stack: { indent, name } — methods in different
  // classes are different scopes, so duplicate checks stay honest.
  const classStack: { indent: number; name: string }[] = [];
  const scopeOf = (indent: number): string => {
    while (classStack.length && (classStack[classStack.length - 1]?.indent ?? 0) >= indent) {
      classStack.pop();
    }
    return classStack.map((c) => c.name).join(".");
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trimEnd();
    const ln = i + 1;
    const indent = raw.length - raw.trimStart().length;
    if (ext === ".py") {
      const fromM = line.match(/^\s*from\s+([\.\w]+)\s+import\s+(.+)$/);
      const impM = line.match(/^\s*import\s+([\w\.]+)/);
      if (fromM && fromM[1]) {
        const syms = (fromM[2] ?? "")
          .replace(/[()]/g, " ")
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
          .filter((s) => s && s !== "*");
        rules.push({
          name: fromM[1], kind: "import", file: path, line: ln, scope: "",
          detail: syms.length ? `symbols: ${syms.join(",")}` : "",
        });
        pendingDecorators = [];
        continue;
      }
      if (impM && impM[1]) {
        rules.push({ name: impM[1], kind: "import", file: path, line: ln, detail: "", scope: "" });
        pendingDecorators = [];
        continue;
      }
      const decM = line.match(/^\s*@([\w\.]+)\s*(\((.*)\))?\s*$/);
      if (decM) {
        pendingDecorators.push(line.trim());
        continue;
      }
      const defM = line.match(/^\s*(?:async\s+def|def)\s+(\w+)/);
      const clsM = line.match(/^\s*class\s+(\w+)/);
      if (defM && defM[1]) {
        const scope = scopeOf(indent);
        rules.push({ name: defM[1], kind: "def", file: path, line: ln, detail: "", scope });
        for (const d of pendingDecorators) {
          if (/\.(get|post|put|delete|patch|route|websocket)\b/.test(d) || d.includes("route")) {
            rules.push({ name: defM[1], kind: "route", file: path, line: ln, detail: d, scope });
          }
        }
        pendingDecorators = [];
        continue;
      }
      if (clsM && clsM[1]) {
        const scope = scopeOf(indent);
        rules.push({ name: clsM[1], kind: "class", file: path, line: ln, detail: "", scope });
        classStack.push({ indent, name: clsM[1] });
        pendingDecorators = [];
        continue;
      }
      if (line.trim() && !line.trim().startsWith("#")) pendingDecorators = [];
    } else {
      const fromM = line.match(/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/);
      const reqM = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
      if (fromM && fromM[1]) {
        rules.push({ name: fromM[1], kind: "import", file: path, line: ln, detail: "", scope: "" });
        continue;
      }
      if (reqM && reqM[1]) {
        rules.push({ name: reqM[1], kind: "import", file: path, line: ln, detail: "", scope: "" });
        continue;
      }
      const fnM = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      const clsM = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
      const constM = line.match(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/);
      if (fnM && fnM[1]) rules.push({ name: fnM[1], kind: "def", file: path, line: ln, detail: "", scope: "" });
      else if (clsM && clsM[1]) rules.push({ name: clsM[1], kind: "class", file: path, line: ln, detail: "", scope: "" });
      else if (constM && constM[1]) rules.push({ name: constM[1], kind: "def", file: path, line: ln, detail: "", scope: "" });
    }
  }
  return rules;
}

// Resolve an import to a repo module, or null when external / unresolvable.
function resolveImport(
  rule: RawRule,
  importerFile: string,
  allPaths: Set<string>,
  packageName: string,
  subpath: string,
): { module: string; targetPath: string } | null {
  const imp = rule.name;
  const toModule = (p: string) => {
    const rel = subpath ? p.slice(subpath.length + 1) : p;
    return moduleOf(rel);
  };
  const candidates: string[] = [];
  if (imp.startsWith(".")) {
    // relative import
    const dirSegs = importerFile.split("/").slice(0, -1);
    let dots = 0;
    while (imp[dots] === ".") dots++;
    const rest = imp.slice(dots).split(".").filter(Boolean);
    const isPy = extOf(importerFile) === ".py";
    const ups = isPy ? dots - 1 : dots - 1;
    const base = dirSegs.slice(0, dirSegs.length - Math.max(0, ups));
    const joined = [...base, ...rest].join("/");
    if (isPy) {
      candidates.push(`${joined}.py`, `${joined}/__init__.py`);
    } else {
      for (const e of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) candidates.push(`${joined}${e}`);
      for (const e of [".ts", ".tsx", ".js", ".jsx"]) candidates.push(`${joined}/index${e}`);
      candidates.push(joined);
    }
  } else if (extOf(importerFile) === ".py") {
    const segs = imp.split(".");
    if (segs[0] !== packageName) return null; // external package
    const rest = segs.slice(1);
    const joined = [subpath, ...rest].filter(Boolean).join("/");
    candidates.push(`${joined}.py`, `${joined}/__init__.py`, subpath ? `${subpath}/__init__.py` : "__init__.py");
  } else {
    return null; // bare JS import = external package
  }
  for (const c of candidates) {
    if (allPaths.has(c)) {
      const m = toModule(c);
      return { module: m.name, targetPath: c };
    }
  }
  return null;
}

// ---------- shared zod shapes ----------

const runShape = z.object({
  id: z.number(),
  repo: z.string(),
  branch: z.string(),
  subpath: z.string(),
  prompt: z.string(),
  status: z.string(),
  phase: z.string(),
  loop: z.number(),
  totalFiles: z.number(),
  totalRules: z.number(),
  verifiedRules: z.number(),
  mismatches: z.number(),
  fixedCount: z.number(),
  currentModule: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

const stateResponse = z.object({
  run: runShape.nullable(),
  modules: z.array(
    z.object({
      id: z.number(), name: z.string(), path: z.string(),
      fileCount: z.number(), status: z.string(),
      rulesFound: z.number(), rulesVerified: z.number(), mismatchCount: z.number(),
    }),
  ),
  rules: z.array(
    z.object({
      id: z.number(), moduleName: z.string(), name: z.string(), kind: z.string(),
      file: z.string(), line: z.number(), status: z.string(), detail: z.string(),
    }),
  ),
  edges: z.array(
    z.object({
      fromModule: z.string(), toModule: z.string(), kind: z.string(), label: z.string(),
    }),
  ),
  logs: z.array(
    z.object({
      id: z.number(), phase: z.string(), message: z.string(), createdAt: z.string(),
    }),
  ),
});

// ---------- actions ----------

export const Actions = {
  getState: defineAction({
    request: z.object({}),
    response: stateResponse,
    async handler(ctx): Promise<z.infer<typeof stateResponse>> {
      const db = ctx.db<typeof schema>();
      const runRows = await db
        .select()
        .from(schema.runs)
        .orderBy(asc(schema.runs.id));
      const run = runRows[runRows.length - 1];
      if (!run) {
        return { run: null, modules: [], rules: [], edges: [], logs: [] };
      }
      const [mods, rls, eds, lgs] = await Promise.all([
        db.select().from(schema.modules).where(eq(schema.modules.runId, run.id)).orderBy(asc(schema.modules.id)),
        db.select().from(schema.rules).where(eq(schema.rules.runId, run.id)).orderBy(asc(schema.rules.id)),
        db.select().from(schema.edges).where(eq(schema.edges.runId, run.id)).orderBy(asc(schema.edges.id)),
        db.select().from(schema.logs).where(eq(schema.logs.runId, run.id)).orderBy(asc(schema.logs.id)),
      ]);
      return {
        run: {
          id: run.id, repo: run.repo, branch: run.branch, subpath: run.subpath,
          prompt: run.prompt, status: run.status, phase: run.phase, loop: run.loop,
          totalFiles: run.totalFiles, totalRules: run.totalRules,
          verifiedRules: run.verifiedRules, mismatches: run.mismatches,
          fixedCount: run.fixedCount, currentModule: run.currentModule,
          error: run.error, startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        },
        modules: mods.map((m) => ({
          id: m.id, name: m.name, path: m.path, fileCount: m.fileCount,
          status: m.status, rulesFound: m.rulesFound,
          rulesVerified: m.rulesVerified, mismatchCount: m.mismatchCount,
        })),
        rules: rls.slice(0, 900).map((r) => ({
          id: r.id, moduleName: r.moduleName, name: r.name, kind: r.kind,
          file: r.file, line: r.line, status: r.status, detail: r.detail,
        })),
        edges: eds.slice(0, 300).map((e) => ({
          fromModule: e.fromModule, toModule: e.toModule, kind: e.kind, label: e.label,
        })),
        logs: lgs.slice(-160).map((l) => ({
          id: l.id, phase: l.phase, message: l.message,
          createdAt: l.createdAt.toISOString(),
        })),
      };
    },
  }),

  startRun: defineAction({
    request: z.object({
      repo: z.string().min(3).max(200),
      branch: z.string().min(1).max(100),
      subpath: z.string().max(200),
      prompt: z.string().max(500),
    }),
    response: z.object({
      ok: z.boolean(),
      runId: z.number(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.fetchRepoCode],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // normalize repo input: accept "owner/repo" or a github.com URL
      let repo = args.repo.trim();
      const urlM = repo.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/);
      if (urlM && urlM[1] && urlM[2]) repo = `${urlM[1]}/${urlM[2].replace(/\.git$/, "")}`;
      repo = repo.replace(/^\/+|\/+$/g, "");
      const branch = args.branch.trim() || "master";
      const subpath = args.subpath.trim().replace(/^\/+|\/+$/g, "");
      const prompt = args.prompt.trim() || "map this codebase";

      // wipe previous runs (single active run model)
      for (const t of [schema.modules, schema.rules, schema.edges, schema.logs, schema.files, schema.runs]) {
        await db.delete(t);
      }

      const inserted = await db
        .insert(schema.runs)
        .values({
          repo, branch, subpath, prompt,
          status: "running", phase: "READ", loop: 1,
        })
        .returning({ id: schema.runs.id });
      const runId = inserted[0]?.id ?? 0;
      await addLog(db, runId, "prompt", `reads prompt: "${prompt}"`);
      await addLog(db, runId, "read", `GET codeload.github.com/${repo}/tar.gz/${branch} …`);

      try {
        const fetched = await ctx.executePrivileged(privileged.fetchRepoCode, {
          repo, branch, subpath,
        });
        const capped: FetchedFile[] = fetched.files;
        if (capped.length === 0) {
          throw new Error(`No code files found under "${subpath || "."}" in ${repo}@${branch}. Try a different subpath.`);
        }
        if (fetched.totalCodeFiles > capped.length) {
          await addLog(db, runId, "read", `⚠ ${fetched.totalCodeFiles} code files found — capping at ${capped.length} for this run`);
        }
        // group into modules
        const byModule = new Map<string, { path: string; files: FetchedFile[] }>();
        for (const f of capped) {
          const rel = subpath ? f.path.slice(subpath.length + 1) : f.path;
          const m = moduleOf(rel);
          const fullPath = subpath ? `${subpath}/${m.path}` : m.path;
          const bucket = byModule.get(m.name) ?? { path: fullPath, files: [] };
          bucket.files.push(f);
          byModule.set(m.name, bucket);
        }
        for (const [name, bucket] of byModule) {
          await db.insert(schema.modules).values({
            runId, name, path: bucket.path,
            fileCount: bucket.files.length,
            filesJson: JSON.stringify(bucket.files.map((f) => f.path)),
            status: "queued",
          });
          for (const f of bucket.files) {
            await db.insert(schema.files).values({
              runId, path: f.path, moduleName: name, size: f.size, content: f.content,
            });
          }
        }
        await db
          .update(schema.runs)
          .set({ totalFiles: capped.length, phase: "READ" })
          .where(eq(schema.runs.id, runId));
        await addLog(db, runId, "read", `READ complete: ${capped.length} code files · ${byModule.size} modules queued`);
        await addLog(db, runId, "loop", `loop #1 — READ → EXTRACT → VERIFY across ${byModule.size} modules`);
        ctx.invalidateQueries();
        return { ok: true, runId, error: null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await db
          .update(schema.runs)
          .set({ status: "error", error: msg, finishedAt: new Date(), phase: "error" })
          .where(eq(schema.runs.id, runId));
        await addLog(db, runId, "error", msg);
        ctx.invalidateQueries();
        return { ok: false, runId, error: msg };
      }
    },
  }),

  stepRun: defineAction({
    request: z.object({ runId: z.number() }),
    response: z.object({
      advanced: z.boolean(),
      finished: z.boolean(),
      phase: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const runRows = await db.select().from(schema.runs).where(eq(schema.runs.id, args.runId));
      const run = runRows[0];
      if (!run || run.status !== "running") {
        return { advanced: false, finished: true, phase: run?.phase ?? "idle" };
      }
      const runId = run.id;
      const subpath = run.subpath;
      const packageName = subpath
        ? (subpath.split("/").filter(Boolean).pop() ?? run.repo.split("/")[1] ?? "")
        : (run.repo.split("/")[1] ?? "");

      const fileRows = await db.select().from(schema.files).where(eq(schema.files.runId, runId));
      const allPaths = new Set(fileRows.map((f) => f.path));
      const mods = await db
        .select()
        .from(schema.modules)
        .where(eq(schema.modules.runId, runId))
        .orderBy(asc(schema.modules.id));

      const finish = async (met: boolean) => {
        await db
          .update(schema.runs)
          .set({ status: "done", phase: "done", currentModule: null, finishedAt: new Date() })
          .where(eq(schema.runs.id, runId));
        const c = await recomputeRun(db, runId);
        await addLog(db, runId, "stop",
          met
            ? `■ STOP CONDITION MET: ${c.verified}/${c.total} verified · 0 mismatches`
            : `■ STOP after ${MAX_LOOPS} loops: ${c.mismatches} mismatch(es) remain — see rules list`);
        ctx.invalidateQueries();
        return { advanced: true, finished: true, phase: "done" };
      };

      // ---------- LOOP 1: per-module READ/EXTRACT/VERIFY ----------
      if (run.loop === 1) {
        const mod = mods.find((m) => m.status === "queued");
        if (!mod) {
          const anyCross = mods.some((m) => m.crossStatus === "pending" && m.status !== "error");
          if (anyCross) {
            await db.update(schema.runs).set({ loop: 2, phase: "VERIFY" }).where(eq(schema.runs.id, runId));
            const c = await recomputeRun(db, runId);
            await addLog(db, runId, "loop", `loop #1 complete — ${c.total} rules extracted, ${c.verified} locally verified · loop #2 cross-reference check`);
            ctx.invalidateQueries();
            return { advanced: true, finished: false, phase: "VERIFY" };
          }
          const c = await recomputeRun(db, runId);
          return finish(c.mismatches === 0);
        }

        await db.update(schema.runs).set({ currentModule: mod.name, phase: "READ" }).where(eq(schema.runs.id, runId));
        await db.update(schema.modules).set({ status: "reading" }).where(eq(schema.modules.id, mod.id));
        const myFiles = fileRows.filter((f) => f.moduleName === mod.name);
        await addLog(db, runId, "read", `[${mod.name}] READ ${Math.min(myFiles.length, PASS1_FILES_PER_MODULE)}/${myFiles.length} files`);
        const passFiles = myFiles.slice(0, PASS1_FILES_PER_MODULE);
        const readable = passFiles.filter((f) => f.content != null);
        if (myFiles.length > PASS1_FILES_PER_MODULE) {
          await addLog(db, runId, "read", `[${mod.name}] ${myFiles.length - PASS1_FILES_PER_MODULE} file(s) deferred to FIX pass`);
        }
        for (const f of passFiles) {
          if (f.content == null) await addLog(db, runId, "read", `[${mod.name}] skip ${f.path} (${Math.round(f.size / 1024)}KB > cap)`);
        }
        if (readable.length === 0) {
          await db.update(schema.modules).set({ status: "error" }).where(eq(schema.modules.id, mod.id));
          await addLog(db, runId, "error", `[${mod.name}] no readable files — marked error`);
          await db.update(schema.runs).set({ currentModule: null }).where(eq(schema.runs.id, runId));
          ctx.invalidateQueries();
          return { advanced: true, finished: false, phase: "READ" };
        }

        await db.update(schema.runs).set({ phase: "EXTRACT" }).where(eq(schema.runs.id, runId));
        await db.update(schema.modules).set({ status: "extracting" }).where(eq(schema.modules.id, mod.id));
        const raw: RawRule[] = [];
        for (const f of readable) {
          raw.push(...extractFromFile(f.path, f.content ?? ""));
        }
        const cappedRaw = raw.slice(0, MAX_RULES_PER_MODULE);
        await addLog(db, runId, "extract", `[${mod.name}] EXTRACT ${cappedRaw.length} rules (imports/defs/classes/routes)`);

        await db.update(schema.runs).set({ phase: "VERIFY" }).where(eq(schema.runs.id, runId));
        await db.update(schema.modules).set({ status: "verifying" }).where(eq(schema.modules.id, mod.id));

        // local verify: duplicate defs within the same file+scope
        // (methods like __init__ in different classes are NOT duplicates)
        const defCounts = new Map<string, number>();
        const defKey = (r: RawRule) => `${r.file}|${r.scope}|${r.name}`;
        for (const r of cappedRaw) {
          if (r.kind === "def" || r.kind === "class") {
            defCounts.set(defKey(r), (defCounts.get(defKey(r)) ?? 0) + 1);
          }
        }
        const moduleNames = mods.map((m) => m.name);
        const seenEdges = new Set<string>();
        const existingEdges = await db.select().from(schema.edges).where(eq(schema.edges.runId, runId));
        for (const e of existingEdges) seenEdges.add(`${e.fromModule}->${e.toModule}:${e.kind}`);
        let mismatchHere = 0;
        for (const r of cappedRaw) {
          let status: "verified" | "mismatch" | "pending" = "verified";
          let detail = r.detail;
          if ((r.kind === "def" || r.kind === "class") && (defCounts.get(defKey(r)) ?? 0) > 1) {
            status = "mismatch";
            detail = `duplicate definition ×${defCounts.get(defKey(r))} in same scope${r.scope ? ` (${r.scope})` : ""}`;
          }
          if (r.kind === "import") {
            const resolved = resolveImport(r, r.file, allPaths, packageName, subpath);
            if (resolved) {
              detail = detail ? `${detail} · → ${resolved.targetPath}` : `→ ${resolved.targetPath}`;
              // keep pending when specific symbols need the cross-check
              status = r.detail.startsWith("symbols:") ? "pending" : "verified";
              const key = `${mod.name}->${resolved.module}:EXTRACTED`;
              if (resolved.module !== mod.name && !seenEdges.has(key)) {
                seenEdges.add(key);
                await db.insert(schema.edges).values({
                  runId, fromModule: mod.name, toModule: resolved.module,
                  kind: "EXTRACTED", label: r.name,
                });
              }
            } else if (r.name.startsWith(".") || r.name.split(".")[0] === packageName) {
              status = "mismatch";
              detail = "internal import target not found in repo tree";
            } else {
              detail = detail ? `${detail} · external package` : "external package";
              status = "verified";
            }
          }
          if (status === "mismatch") mismatchHere++;
          await db.insert(schema.rules).values({
            runId, moduleName: mod.name, name: r.name, kind: r.kind,
            file: r.file, line: r.line, status, detail,
          });
        }
        // INFERRED edges: module names mentioned in source without an import
        const importedTargets = new Set(
          cappedRaw.filter((r) => r.kind === "import").map((r) => r.name.split(".").pop() ?? ""),
        );
        let inferred = 0;
        for (const f of readable) {
          if (inferred >= 3) break;
          const text = f.content ?? "";
          for (const other of moduleNames) {
            if (inferred >= 3) break;
            if (other === mod.name || other.length < 4 || importedTargets.has(other)) continue;
            if (new RegExp(`\\b${other}\\b`).test(text)) {
              const key = `${mod.name}->${other}:INFERRED`;
              if (!seenEdges.has(key)) {
                seenEdges.add(key);
                await db.insert(schema.edges).values({
                  runId, fromModule: mod.name, toModule: other, kind: "INFERRED", label: "name reference",
                });
                inferred++;
              }
            }
          }
        }
        const finalStatus = mismatchHere > 0 ? "mismatch" : "verified";
        await db.update(schema.modules).set({ status: finalStatus }).where(eq(schema.modules.id, mod.id));
        await refreshModuleCounts(db, mod.id, runId, mod.name);
        const c = await recomputeRun(db, runId);
        await addLog(db, runId, "verify",
          `[${mod.name}] VERIFY ${cappedRaw.length - mismatchHere}/${cappedRaw.length} ok${mismatchHere ? ` · ${mismatchHere} mismatch` : ""} · totals ${c.verified}/${c.total}`);
        await db.update(schema.runs).set({ currentModule: null }).where(eq(schema.runs.id, runId));
        ctx.invalidateQueries();
        return { advanced: true, finished: false, phase: "VERIFY" };
      }

      // ---------- LOOP 2: cross-reference symbol check ----------
      if (run.loop === 2) {
        const mod = mods.find((m) => m.crossStatus === "pending" && m.status !== "error");
        if (!mod) {
          const c = await recomputeRun(db, runId);
          if (c.mismatches > 0) {
            await db.update(schema.runs).set({ loop: 3, phase: "FIX" }).where(eq(schema.runs.id, runId));
            for (const m of mods) {
              const rows = await db.select().from(schema.rules).where(eq(schema.rules.runId, runId));
              if (rows.some((r) => r.moduleName === m.name && r.status === "mismatch")) {
                await db.update(schema.modules).set({ crossStatus: "fix-pending" }).where(eq(schema.modules.id, m.id));
              }
            }
            await addLog(db, runId, "loop", `loop #2 complete — ${c.mismatches} mismatch(es) · loop #3 FIX pass: re-read deferred files & re-check`);
            ctx.invalidateQueries();
            return { advanced: true, finished: false, phase: "FIX" };
          }
          return finish(true);
        }
        await db.update(schema.runs).set({ currentModule: mod.name, phase: "VERIFY" }).where(eq(schema.runs.id, runId));
        const myRules = (await db.select().from(schema.rules).where(eq(schema.rules.runId, runId)))
          .filter((r) => r.moduleName === mod.name && r.status === "pending" && r.kind === "import");
        const allRules = await db.select().from(schema.rules).where(eq(schema.rules.runId, runId));
        let checked = 0;
        let bad = 0;
        for (const rule of myRules) {
          const resolved = resolveImport(
            { name: rule.name, kind: rule.kind, file: rule.file, line: rule.line, detail: rule.detail, scope: "" },
            rule.file, allPaths, packageName, subpath,
          );
          if (!resolved) continue;
          const targetDefs = new Set(
            allRules.filter((r) => r.moduleName === resolved.module && (r.kind === "def" || r.kind === "class")).map((r) => r.name),
          );
          const targetImports = new Set<string>();
          for (const r of allRules.filter((x) => x.moduleName === resolved.module && x.kind === "import")) {
            if (r.detail.startsWith("symbols:")) {
              for (const s of r.detail.slice(8).split("·")[0]?.split(",") ?? []) targetImports.add(s.trim());
            }
          }
          const syms = (rule.detail.split("·")[0]?.replace("symbols:", "").split(",") ?? [])
            .map((s) => s.trim()).filter(Boolean);
          const missing: string[] = [];
          for (const s of syms) {
            // submodule file counts as found
            const subFile = subpath
              ? `${subpath}/${resolved.module}/${s}.py`
              : `${resolved.module}/${s}.py`;
            const asModule = allPaths.has(subFile) || [...allPaths].some((p) => p.endsWith(`/${s}.py`) || p.endsWith(`/${s}/__init__.py`));
            if (!targetDefs.has(s) && !targetImports.has(s) && !asModule) missing.push(s);
          }
          checked++;
          if (missing.length) {
            bad++;
            await db.update(schema.rules)
              .set({ status: "mismatch", detail: `${rule.detail} · symbols not found in ${resolved.module}: ${missing.join(", ")}` })
              .where(eq(schema.rules.id, rule.id));
          } else {
            await db.update(schema.rules)
              .set({ status: "verified" })
              .where(eq(schema.rules.id, rule.id));
          }
        }
        await db.update(schema.modules).set({ crossStatus: "done" }).where(eq(schema.modules.id, mod.id));
        await refreshModuleCounts(db, mod.id, runId, mod.name);
        const c = await recomputeRun(db, runId);
        await addLog(db, runId, "verify", `[${mod.name}] CROSS-CHECK ${checked} import(s)${bad ? ` · ${bad} mismatch` : " · all symbols resolve"} · totals ${c.verified}/${c.total}`);
        await db.update(schema.runs).set({ currentModule: null }).where(eq(schema.runs.id, runId));
        ctx.invalidateQueries();
        return { advanced: true, finished: false, phase: "VERIFY" };
      }

      // ---------- LOOP 3: FIX — re-read deferred files, re-check ----------
      const mod = mods.find((m) => m.crossStatus === "fix-pending");
      if (!mod) {
        const c = await recomputeRun(db, runId);
        return finish(c.mismatches === 0);
      }
      await db.update(schema.runs).set({ currentModule: mod.name, phase: "FIX" }).where(eq(schema.runs.id, runId));
      const allRules = await db.select().from(schema.rules).where(eq(schema.rules.runId, runId));
      const myBad = allRules.filter((r) => r.moduleName === mod.name && r.status === "mismatch");
      let fixedHere = 0;
      for (const rule of myBad) {
        if (rule.kind !== "import") continue;
        const resolved = resolveImport(
          { name: rule.name, kind: rule.kind, file: rule.file, line: rule.line, detail: rule.detail, scope: "" },
          rule.file, allPaths, packageName, subpath,
        );
        if (!resolved) continue;
        // deep re-read: ALL files of the target module, including deferred ones
        const targetFiles = fileRows.filter((f) => f.moduleName === resolved.module && f.content != null);
        const freshDefs = new Set<string>();
        for (const f of targetFiles) {
          for (const r of extractFromFile(f.path, f.content ?? "")) {
            if (r.kind === "def" || r.kind === "class") freshDefs.add(r.name);
          }
        }
        const syms = (rule.detail.split("·")[0]?.replace("symbols:", "").split(",") ?? [])
          .map((s) => s.trim()).filter(Boolean);
        const stillMissing = syms.filter((s) => !freshDefs.has(s));
        if (syms.length && stillMissing.length < syms.length && stillMissing.length === 0) {
          await db.update(schema.rules)
            .set({ status: "fixed", detail: `${rule.detail} · FIXED in loop #3 (deep re-read of ${resolved.module})` })
            .where(eq(schema.rules.id, rule.id));
          fixedHere++;
        } else if (!rule.detail.includes("symbols:")) {
          // plain import target mismatch: target may sit in a deferred file set — recheck tree
          if (resolved) {
            await db.update(schema.rules)
              .set({ status: "fixed", detail: `${rule.detail} · FIXED in loop #3` })
              .where(eq(schema.rules.id, rule.id));
            fixedHere++;
          }
        }
      }
      await db.update(schema.modules).set({ crossStatus: "done" }).where(eq(schema.modules.id, mod.id));
      await refreshModuleCounts(db, mod.id, runId, mod.name);
      const c = await recomputeRun(db, runId);
      await addLog(db, runId, "fix", `[${mod.name}] FIX pass: ${fixedHere} fixed · ${c.mismatches} mismatch(es) remain`);
      await db.update(schema.runs).set({ currentModule: null }).where(eq(schema.runs.id, runId));
      ctx.invalidateQueries();
      return { advanced: true, finished: false, phase: "FIX" };
    },
  }),

  stopRun: defineAction({
    request: z.object({ runId: z.number() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.runs)
        .set({ status: "stopped", phase: "stopped", finishedAt: new Date(), currentModule: null })
        .where(eq(schema.runs.id, args.runId));
      await addLog(db, args.runId, "stop", "■ stopped by user");
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
