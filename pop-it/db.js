const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'pop.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target INTEGER NOT NULL,          -- nombre secret (jamais envoyé aux clients)
  salt TEXT NOT NULL,
  commit_hash TEXT NOT NULL DEFAULT '',
  taps INTEGER NOT NULL DEFAULT 0,
  winner TEXT, prize TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL, flag TEXT,
  taps_all INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS taps_hourly (
  hour TEXT PRIMARY KEY,            -- '2026-09-10T14' (UTC)
  taps INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS uniq (   -- visiteurs/joueurs distincts par fenêtre
  bucket TEXT NOT NULL,             -- 'h:2026-09-10T14' ou 'd:2026-09-10'
  pid TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('visitor','player')),
  PRIMARY KEY (bucket, pid, kind)
);
`);
module.exports = db;
