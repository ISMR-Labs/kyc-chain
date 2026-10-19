import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function openStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(directory, 'keys.json');
  const dbPath = path.join(directory, 'vault.sqlite');
  if (!fs.existsSync(keyPath)) {
    if (fs.existsSync(dbPath)) throw new Error('Encryption keys are missing. Restore keys.json from the same backup as the vault.');
    fs.writeFileSync(keyPath, JSON.stringify({ encryption: randomBytes(32).toString('hex'), index: randomBytes(32).toString('hex'), chainSeed: randomBytes(32).toString('hex') }), { mode: 0o600, flag: 'wx' });
  }
  const keys = JSON.parse(fs.readFileSync(keyPath));
  const db = new DatabaseSync(dbPath);
  fs.chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS institutions(id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL, address TEXT UNIQUE NOT NULL, slot INTEGER UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, institution TEXT REFERENCES institutions(id));
    CREATE TABLE IF NOT EXISTS identities(id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, owner TEXT NOT NULL REFERENCES institutions(id), customer TEXT NOT NULL REFERENCES users(id), latest INTEGER NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS versions(identity TEXT NOT NULL REFERENCES identities(id), version INTEGER NOT NULL, ciphertext TEXT NOT NULL, digest TEXT NOT NULL, previous TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, created TEXT NOT NULL, tx TEXT NOT NULL, block INTEGER NOT NULL, PRIMARY KEY(identity,version));
    CREATE TABLE IF NOT EXISTS consents(id TEXT PRIMARY KEY, identity TEXT NOT NULL REFERENCES identities(id), requester TEXT NOT NULL REFERENCES institutions(id), version INTEGER NOT NULL, purpose TEXT NOT NULL, state TEXT NOT NULL, expires TEXT, created TEXT NOT NULL, tx TEXT);
    CREATE TABLE IF NOT EXISTS reuses(id TEXT PRIMARY KEY, identity TEXT NOT NULL REFERENCES identities(id), institution TEXT NOT NULL REFERENCES institutions(id), version INTEGER NOT NULL, created TEXT NOT NULL, tx TEXT NOT NULL, block INTEGER NOT NULL, UNIQUE(identity,institution,version));
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, institution TEXT, action TEXT NOT NULL, identity TEXT, detail TEXT NOT NULL, created TEXT NOT NULL, tx TEXT, block INTEGER);
    CREATE TABLE IF NOT EXISTS outbox(hash TEXT PRIMARY KEY, raw TEXT NOT NULL, queries TEXT NOT NULL, state TEXT NOT NULL, block INTEGER);
    CREATE INDEX IF NOT EXISTS consent_lookup ON consents(identity,requester,state);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL, touched INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS session_user ON sessions(user);
    CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
  `);
  if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }
  return { db, keys };
}
