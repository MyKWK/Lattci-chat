import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export function openStore(profile) {
  const db = new DatabaseSync(join(profile.directory, 'lattice.sqlite'));
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT,
        permission TEXT NOT NULL CHECK(permission IN ('none', 'full')), description TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, peer TEXT NOT NULL, direction TEXT NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, replyTo TEXT,
        createdAt INTEGER NOT NULL, state TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS messages_queue ON messages(direction, state, createdAt);
    `);
    if (!db.prepare('PRAGMA table_info(peers)').all().some((column) => column.name === 'description')) {
      db.exec('ALTER TABLE peers ADD COLUMN description TEXT');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
