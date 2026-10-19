import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { passwordHash } from './crypto.js';

export function bootstrapAdmin(db, directory, email = process.env.ADMIN_EMAIL || 'admin@kyc.local') {
  if (db.prepare("SELECT id FROM users WHERE role='admin'").get()) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL must be a valid email address');
  const password = randomBytes(24).toString('base64url');
  const destination = path.join(directory, 'bootstrap-admin.txt');
  fs.writeFileSync(destination, `KYC Chain initial administrator\nEmail: ${email}\nPassword: ${password}\n\nChange this password on first sign-in. This file is not served by the application.\n`, { mode: 0o600, flag: 'wx' });
  db.prepare('INSERT INTO users(id,email,name,password,role,institution,must_change_password) VALUES (?,?,?,?,?,?,1)').run(randomUUID(), email.toLowerCase(), 'Consortium Administrator', passwordHash(password), 'admin', null);
  console.log('Initial administrator created. Credentials are in the protected bootstrap-admin.txt file in DATA_DIR.');
}
