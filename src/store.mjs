import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export function openStore(profile) {
  const db = new DatabaseSync(join(profile.directory, 'lattice.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT,
      permission TEXT NOT NULL CHECK(permission IN ('none', 'full'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, peer TEXT NOT NULL, direction TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, replyTo TEXT,
      createdAt INTEGER NOT NULL, state TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS messages_queue ON messages(direction, state, createdAt);
  `);
  return db;
}
