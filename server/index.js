import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { openStore } from './store.js';
import { openChain } from './chain.js';
import { KYCService, seed, AppError, requireValue } from './service.js';
import { checkPassword, passwordHash } from './crypto.js';
import { bootstrapAdmin } from './bootstrap.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');

export async function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), seedDemo = process.env.SEED_DEMO === 'true', production = process.env.NODE_ENV === 'production', publicOrigin = process.env.PUBLIC_ORIGIN, trustProxy = process.env.TRUST_PROXY, adminEmail = process.env.ADMIN_EMAIL, allowEmbeddedLedger = false } = {}) {
  if (production && seedDemo) throw new Error('Demo seeding is disabled in production.');
  if (production && (!publicOrigin || new URL(publicOrigin).protocol !== 'https:')) throw new Error('Production requires an HTTPS PUBLIC_ORIGIN.');
  if (production && !process.env.RPC_URL && !allowEmbeddedLedger) throw new Error('Production requires a private RPC_URL; embedded Ganache is only available in training and tests.');
  if (publicOrigin) publicOrigin = new URL(publicOrigin).origin;
  const { db, keys } = openStore(dataDir);
  if (production && db.prepare("SELECT value FROM settings WHERE key='seeded'").get()) { db.close(); throw new Error('Refusing to serve a demo database in production. Use a clean DATA_DIR.'); }
  const chain = await openChain(dataDir, keys, db);
  const service = new KYCService(db, keys, chain);
  service.hardened = !seedDemo;
  if (seedDemo) await seed(service);
  else bootstrapAdmin(db, dataDir, adminEmail);
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy.split(',').map(x => x.trim()));
  const dummyHash = passwordHash(randomBytes(32).toString('hex'));
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: production, maxAge: 8 * 3600000, path: '/' };
  function createSession(req, res, actor) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const old = /(?:^|;\s*)kyc_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (old) db.prepare('DELETE FROM sessions WHERE token=?').run(digest(old));
    db.prepare('INSERT INTO sessions(token,user,csrf,expires,touched) VALUES (?,?,?,?,?)').run(digest(token), actor.id, csrf, Date.now() + 8 * 3600000, Date.now());
    res.cookie('kyc_session', token, { ...cookieOptions, secure: production || req.secure });
    return { user: actor, csrf };
  }
  function enforceLimit(key, maximum, windowMs) {
    const entry = db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
    requireValue(!entry || entry.until <= Date.now() || entry.count < maximum, 429, 'Too many attempts. Please try again later.');
    db.prepare('INSERT INTO login_attempts(key,count,until) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,until=excluded.until').run(key, entry && entry.until > Date.now() ? entry.count + 1 : 1, entry && entry.until > Date.now() ? entry.until : Date.now() + windowMs);
  }
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-ID', req.requestId);
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (production && req.path !== '/api/health') {
      requireValue(req.secure, 400, 'HTTPS is required.');
      requireValue(req.get('host') === new URL(publicOrigin).host, 400, 'Unrecognized application host.');
    }
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && origin !== (publicOrigin || `${req.protocol}://${req.get('host')}`)) return res.status(403).json({ error: 'Cross-origin writes are not allowed.' });
      if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site writes are not allowed.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send application/json.' });
    }
    next();
  });
  app.use(express.json({ limit: '4mb' }));
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET') requireValue(req.body && typeof req.body === 'object' && !Array.isArray(req.body), 400, 'Send a JSON object.');
    next();
  });
  app.get('/api/health', async (_, res) => {
    const pending = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='prepared'").get().n;
    try {
      await chain.provider.getBlockNumber();
      res.status(pending ? 503 : 200).json({ status: pending ? 'recovering' : 'ok' });
    } catch { res.status(503).json({ status: 'ledger-unavailable' }); }
  });
  app.post('/api/login', (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    requireValue(email.length <= 120 && password.length <= 200, 400, 'Invalid login.');
    const attemptKey = 'login-account:' + digest(email);
    enforceLimit('login-ip:' + digest(req.ip), 60, 600000);
    enforceLimit(attemptKey, 10, 600000);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const valid = checkPassword(password, user?.password ?? dummyHash);
    if (!valid || !user) {
      throw new AppError(401, 'Email or password is incorrect.');
    }
    db.prepare('DELETE FROM login_attempts WHERE key=?').run(attemptKey);
    const actor = service.user(user.id);
    service.run(service.audit(actor, 'SIGNED_IN', null, 'Authenticated session created'));
    res.json(createSession(req, res, actor));
  });
  app.use('/api', (req, res, next) => {
    const token = /(?:^|;\s*)kyc_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const session = token && db.prepare('SELECT * FROM sessions WHERE token=?').get(digest(token));
    requireValue(session && session.expires > Date.now() && session.touched > Date.now() - 30 * 60000, 401, 'Please sign in to continue.');
    if (!['GET', 'HEAD'].includes(req.method)) requireValue(req.get('x-csrf-token') === session.csrf, 403, 'Your session token is invalid. Sign in again.');
    req.actor = service.user(session.user);
    requireValue(req.actor, 401, 'Account not found.');
    req.session = session;
    db.prepare('UPDATE sessions SET touched=? WHERE token=?').run(Date.now(), session.token);
    requireValue(!req.actor.must_change_password || ['/me', '/account/password', '/logout'].includes(req.path), 403, 'Change your temporary password before accessing the workspace.');
    if (!['GET', 'HEAD'].includes(req.method)) enforceLimit('write:' + req.actor.id, 120, 60000);
    next();
  });
  app.get('/api/me', (req, res) => res.json({ user: req.actor, csrf: req.session.csrf }));
  app.post('/api/logout', (req, res) => { db.prepare('DELETE FROM sessions WHERE token=?').run(req.session.token); res.clearCookie('kyc_session', { path: '/', secure: production || req.secure, httpOnly: true, sameSite: 'strict' }); res.json({ ok: true }); });
  app.post('/api/account/password', (req, res) => {
    enforceLimit('password:' + req.actor.id, 10, 600000);
    const { currentPassword, newPassword } = req.body;
    requireValue(typeof currentPassword === 'string' && currentPassword.length <= 200 && typeof newPassword === 'string' && newPassword.length >= 14 && newPassword.length <= 200, 400, 'Use a new password with 14–200 characters.');
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.actor.id);
    requireValue(checkPassword(currentPassword, user.password), 403, 'The current password is incorrect.');
    requireValue(newPassword !== currentPassword && new Set(newPassword).size >= 6 && !newPassword.toLowerCase().includes(req.actor.email.toLowerCase()), 400, 'Choose a unique passphrase that is different from your current password.');
    const hashed = passwordHash(newPassword);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE users SET password=?,must_change_password=0 WHERE id=?').run(hashed, user.id);
      db.prepare('DELETE FROM sessions WHERE user=?').run(user.id);
      service.run(service.audit(req.actor, 'PASSWORD_CHANGED', null, 'Password changed; all previous sessions revoked'));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json(createSession(req, res, service.user(user.id)));
  });
  app.get('/api/dashboard', async (req, res) => res.json(await service.dashboard(req.actor)));
  app.get('/api/identities', (req, res) => res.json(service.list(req.actor)));
  app.get('/api/identities/:id', (req, res) => res.json(service.detail(req.actor, req.params.id)));
  app.get('/api/identities/:id/integrity', async (req, res) => res.json(await service.integrity(req.actor, req.params.id)));
  app.get('/api/identities/:id/evidence/:version', (req, res) => {
    const item = service.identity(req.params.id);
    const version = Number(req.params.version);
    requireValue(service.allowed(req.actor, item).includes(version), 403, 'You do not have access to this evidence version.');
    const file = service.payload(service.version(item.id, version)).data.evidence;
    requireValue(file, 404, 'No evidence file was attached to this version.');
    service.run(service.audit(req.actor, 'EVIDENCE_DOWNLOADED', item.id, `Version ${version}`));
    res.set('Content-Disposition', `attachment; filename="evidence-${version}.${file.type === 'application/pdf' ? 'pdf' : file.type === 'image/png' ? 'png' : 'jpg'}"`);
    res.type(file.type).send(Buffer.from(file.base64, 'base64'));
  });
  const write = handler => async (req, res) => res.json(await service.write(() => handler(req)));
  app.post('/api/deduplicate', write(req => service.deduplicate(req.actor, req.body)));
  app.post('/api/identities', write(req => service.create(req.actor, req.body)));
  app.post('/api/identities/:id/versions', write(req => service.update(req.actor, req.params.id, req.body)));
  app.post('/api/identities/:id/consents', write(req => service.requestConsent(req.actor, req.params.id, req.body)));
  app.post('/api/identities/:id/reuse', write(req => service.reuse(req.actor, req.params.id, req.body)));
  app.get('/api/consents', (req, res) => res.json(service.consents(req.actor)));
  app.post('/api/consents/:id/decision', write(req => service.decideConsent(req.actor, req.params.id, req.body)));
  app.get('/api/audit', (req, res) => res.json(service.auditLog(req.actor)));
  app.get('/api/network', async (_, res) => res.json(await service.network()));
  app.post('/api/institutions', write(req => service.addInstitution(req.actor, req.body)));
  app.use('/api', (_, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use(express.static(path.join(root, 'public')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    if (status >= 500) console.error(JSON.stringify({ level: 'error', requestId: req.requestId, message: error.message }));
    res.status(status).json({ error: status >= 500 ? 'The operation could not complete. Contact your administrator with the request ID.' : error.message, requestId: req.requestId, ...(error.details ? { details: error.details } : {}) });
  });
  const cleanup = setInterval(() => {
    db.prepare('DELETE FROM sessions WHERE expires<=? OR touched<=?').run(Date.now(), Date.now() - 30 * 60000);
    db.prepare('DELETE FROM login_attempts WHERE until<=?').run(Date.now());
  }, 60000).unref();
  return { app, service, db, chain, async close() { clearInterval(cleanup); await service.tail; await chain.close(); db.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('Starting KYC Chain: opening encrypted vault and local Ethereum ledger…');
  const runtime = await createApp();
  const port = Number(process.env.PORT || 4310);
  const host = process.env.HOST || '127.0.0.1';
  const server = runtime.app.listen(port, host, async error => {
    if (error) { console.error(`Unable to listen on ${host}:${port}: ${error.message}`); await runtime.close(); process.exitCode = 1; return; }
    console.log(`KYC Chain ready at ${process.env.PUBLIC_ORIGIN || `http://${host}:${port}`}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(async () => { await runtime.close(); process.exit(0); }); });
}
