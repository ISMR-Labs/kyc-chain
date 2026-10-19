import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { createApp } from '../server/index.js';

test('deployment: empty tenant, HTTPS, password rotation, sessions, throttling and separated help', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-deploy-'));
  const options = { dataDir: directory, production: true, seedDemo: false, publicOrigin: 'https://kyc.example.test', trustProxy: 'loopback', adminEmail: 'owner@example.test', allowEmbeddedLedger: true };
  let runtime, server, base;
  async function start() {
    runtime = await createApp(options);
    server = await new Promise((resolve, reject) => { const s = runtime.app.listen(0, '127.0.0.1', e => e ? reject(e) : resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { if (server) await new Promise(resolve => server.close(resolve)); await runtime?.close(); server = null; runtime = null; }
  let cookie = '', csrf = '';
  async function call(route, body, expected = 200, headers = {}) {
    const response = await new Promise((resolve, reject) => {
      const req = request(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { Host: 'kyc.example.test', 'X-Forwarded-Proto': 'https', Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([k,v]) => [k, Array.isArray(v) ? v.join(',') : v])) })));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    assert.equal(response.status, expected, await response.clone().text());
    return response;
  }
  try {
    await assert.rejects(createApp({ ...options, seedDemo: true }), /Demo seeding/);
    await assert.rejects(createApp({ ...options, publicOrigin: 'http://kyc.example.test' }), /HTTPS/);
    await start();
    assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM identities').get().n, 0);
    assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM institutions').get().n, 0);
    const credentials = fs.readFileSync(path.join(directory, 'bootstrap-admin.txt'), 'utf8');
    const password = credentials.match(/Password: (.+)/)[1];
    await call('/api/login', { email: 'admin@kyc.demo', password: 'Demo@12345' }, 401);
    await call('/api/me', undefined, 400, { 'X-Forwarded-Proto': 'http' });
    await call('/api/me', undefined, 400, { Host: 'attacker.example' });
    const login = await call('/api/login', { email: 'owner@example.test', password });
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /Secure/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
    cookie = login.headers.get('set-cookie').split(';')[0];
    const session = await login.json(); csrf = session.csrf;
    assert.equal(session.user.must_change_password, 1);
    await call('/api/dashboard', undefined, 403);
    await call('/api/account/password', { currentPassword: password, newPassword: 'short' }, 400);
    const oldCookie = cookie;
    const changed = await call('/api/account/password', { currentPassword: password, newPassword: 'Correct-Harbor-7-Sunrise!' });
    cookie = changed.headers.get('set-cookie').split(';')[0];
    const fresh = await changed.json(); csrf = fresh.csrf;
    assert.equal(fresh.user.must_change_password, 0);
    await call('/api/me', undefined, 401, { Cookie: oldCookie });
    await call('/api/dashboard');
    await call('/api/institutions', { name: 'Production Test Bank', code: 'PTB', email: 'officer@example.test' });
    assert.equal(runtime.db.prepare('SELECT must_change_password FROM users WHERE email=?').get('officer@example.test').must_change_password, 1);
    await call('/api/institutions', { name: 'Invalid', code: 'BAD', email: 'x@example.test' }, 403, { Origin: 'https://attacker.example' });
    await call('/api/login', { email: 'owner@example.test', password }, 401);
    await stop(); await start();
    await call('/api/me'); // Session persists across controlled restarts.
    const script = await (await call('/app.js')).text();
    for (const sample of ['Demo@12345', '199512345678', 'Run the five-minute demo', 'officer@ceylon.demo', 'RESEARCH PROTOTYPE']) assert.ok(!script.includes(sample), sample);
    assert.ok((await (await call('/help/')).text()).includes('Help Center'));
    assert.ok((await (await call('/help/training.html')).text()).includes('Run the five-minute demo'));
    for (let i = 0; i < 10; i++) await call('/api/login', { email: 'unknown@example.test', password: 'invalid' }, 401);
    await call('/api/login', { email: 'unknown@example.test', password: 'invalid' }, 429);
    runtime.db.prepare('UPDATE sessions SET touched=?').run(Date.now() - 31 * 60000);
    await call('/api/me', undefined, 401);
  } finally { await stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});
