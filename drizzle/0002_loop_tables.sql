CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  subpath TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'idle',
  loop INTEGER NOT NULL DEFAULT 1,
  total_files INTEGER NOT NULL DEFAULT 0,
  total_rules INTEGER NOT NULL DEFAULT 0,
  verified_rules INTEGER NOT NULL DEFAULT 0,
  mismatches INTEGER NOT NULL DEFAULT 0,
  fixed_count INTEGER NOT NULL DEFAULT 0,
  current_module TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
--> statement-breakpoint
CREATE TABLE modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  files_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued',
  cross_status TEXT NOT NULL DEFAULT 'pending',
  rules_found INTEGER NOT NULL DEFAULT 0,
  rules_verified INTEGER NOT NULL DEFAULT 0,
  mismatch_count INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  module_name TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  from_module TEXT NOT NULL,
  to_module TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  module_name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  content TEXT
);
--> statement-breakpoint
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
