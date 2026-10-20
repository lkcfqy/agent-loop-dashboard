import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const entries = sqliteTable("entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repo: text("repo").notNull(),
  branch: text("branch").notNull(),
  subpath: text("subpath").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status", {
    enum: ["running", "done", "error", "stopped"],
  }).notNull(),
  phase: text("phase").notNull().default("idle"),
  loop: integer("loop").notNull().default(1),
  totalFiles: integer("total_files").notNull().default(0),
  totalRules: integer("total_rules").notNull().default(0),
  verifiedRules: integer("verified_rules").notNull().default(0),
  mismatches: integer("mismatches").notNull().default(0),
  fixedCount: integer("fixed_count").notNull().default(0),
  currentModule: text("current_module"),
  error: text("error"),
  startedAt: integer("started_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});

export const modules = sqliteTable("modules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  fileCount: integer("file_count").notNull().default(0),
  filesJson: text("files_json").notNull().default("[]"),
  status: text("status", {
    enum: [
      "queued",
      "reading",
      "extracting",
      "verifying",
      "verified",
      "mismatch",
      "error",
    ],
  })
    .notNull()
    .default("queued"),
  crossStatus: text("cross_status").notNull().default("pending"),
  rulesFound: integer("rules_found").notNull().default(0),
  rulesVerified: integer("rules_verified").notNull().default(0),
  mismatchCount: integer("mismatch_count").notNull().default(0),
});

export const rules = sqliteTable("rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  moduleName: text("module_name").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  file: text("file").notNull(),
  line: integer("line").notNull().default(0),
  status: text("status", {
    enum: ["pending", "verified", "mismatch", "fixed"],
  })
    .notNull()
    .default("pending"),
  detail: text("detail").notNull().default(""),
});

export const edges = sqliteTable("edges", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  fromModule: text("from_module").notNull(),
  toModule: text("to_module").notNull(),
  kind: text("kind", { enum: ["EXTRACTED", "INFERRED"] }).notNull(),
  label: text("label").notNull().default(""),
});

export const files = sqliteTable("files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  path: text("path").notNull(),
  moduleName: text("module_name").notNull(),
  size: integer("size").notNull().default(0),
  content: text("content"),
});

export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  phase: text("phase").notNull(),
  message: text("message").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
