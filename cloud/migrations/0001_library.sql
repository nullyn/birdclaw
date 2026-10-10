CREATE TABLE documents (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL,
  text TEXT NOT NULL, document_json TEXT NOT NULL, content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE INDEX documents_source_account ON documents(source, account);
CREATE TABLE passages (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
  ordinal INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
  start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
  content_hash TEXT NOT NULL, indexed_hash TEXT,
  UNIQUE(document_id, ordinal)
);
CREATE INDEX passages_pending ON passages(indexed_hash, document_id);
CREATE VIRTUAL TABLE passages_fts USING fts5(title, text, content='passages', content_rowid='rowid');
CREATE TRIGGER passages_insert AFTER INSERT ON passages BEGIN
  INSERT INTO passages_fts(rowid,title,text) VALUES(new.rowid,new.title,new.text);
END;
CREATE TRIGGER passages_delete AFTER DELETE ON passages BEGIN
  INSERT INTO passages_fts(passages_fts,rowid,title,text) VALUES('delete',old.rowid,old.title,old.text);
END;
CREATE TABLE vector_tombstones (id TEXT PRIMARY KEY);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}', result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX one_active_source_job ON jobs(source) WHERE status IN ('queued','running','waiting-budget');
CREATE TABLE browser_budget (day TEXT PRIMARY KEY, launches INTEGER NOT NULL, last_launch_at INTEGER NOT NULL);
