import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../server/store.js';
import { passwordHash } from '../server/crypto.js';

// Operator-only recovery. Stop the application before running this command.
const email = process.argv[2];
if (!email) throw new Error('Usage: node scripts/reset-password.js account@example.com');
const directory = process.env.DATA_DIR || path.resolve('data');
const { db } = openStore(directory);
try {
  const user = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
  if (!user) throw new Error('Account not found');
  const password = randomBytes(24).toString('base64url');
  const target = path.join(directory, 'password-reset-' + Date.now() + '.txt');
  fs.writeFileSync(target, `Email: ${email}\nTemporary password: ${password}\nReplace it at first sign-in.\n`, { mode: 0o600, flag: 'wx' });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET password=?,must_change_password=1 WHERE id=?').run(passwordHash(password), user.id);
    db.prepare('DELETE FROM sessions WHERE user=?').run(user.id);
    db.prepare('INSERT INTO audit(actor,action,detail,created) VALUES (?,?,?,?)').run(user.id, 'OPERATOR_PASSWORD_RESET', 'Server operator reset this account; all sessions revoked', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  console.log(`Temporary credentials written to ${target}. No password was printed.`);
} finally { db.close(); }
