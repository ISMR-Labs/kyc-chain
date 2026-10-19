import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { fingerprint, hash, encrypt, decrypt, canonical } from '../server/crypto.js';

test('cryptography: canonical hashing, keyed normalization and authenticated context', () => {
  const keys = { encryption: 'ab'.repeat(32), index: 'cd'.repeat(32) };
  assert.equal(hash(canonical({ b: 1, a: 2 })), hash(canonical({ a: 2, b: 1 })));
  const doc = { country: 'LK', documentType: 'NIC', documentNumber: ' ab-123 456 ' };
  assert.equal(fingerprint(keys, doc), fingerprint(keys, { ...doc, documentNumber: 'AB123456' }));
  assert.notEqual(fingerprint(keys, doc), fingerprint(keys, { ...doc, country: 'IN' }));
  assert.notEqual(fingerprint(keys, doc), fingerprint({ ...keys, index: 'ef'.repeat(32) }, doc));
  const ciphertext = encrypt(keys, { fullName: 'Private Person' }, 'record:1');
  assert.ok(!ciphertext.includes('Private Person'));
  assert.deepEqual(decrypt(keys, ciphertext, 'record:1'), { fullName: 'Private Person' });
  assert.throws(() => decrypt(keys, ciphertext, 'record:2'));
  assert.throws(() => decrypt(keys, ciphertext.slice(0, -2) + 'ff', 'record:1'));
});

test('end-to-end consortium workflow, authorization, real EVM constraints and restart recovery', { timeout: 180000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-chain-test-'));
  let runtime, server, base;
  async function start() {
    runtime = await createApp({ dataDir: directory, seedDemo: true });
    server = await new Promise((resolve, reject) => { const listening = runtime.app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(listening)); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { if (server) await new Promise(resolve => server.close(resolve)); if (runtime) await runtime.close(); }
  async function client(email, password = 'Demo@12345') {
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return { user: result.user, cookie, csrf: result.csrf, async call(url, data, expected = 200, extraHeaders = {}) {
      const response = await fetch(base + '/api' + url, { method: data === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': result.csrf }), ...extraHeaders }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
    } };
  }
  try {
    await start();
    let a = await client('officer@ceylon.demo');
    let b = await client('officer@serendib.demo');
    let c = await client('customer@kyc.demo');
    let admin = await client('admin@kyc.demo');
    const asha = runtime.db.prepare("SELECT * FROM identities WHERE customer='customer'").get();
    const ashaId = asha.id;
    let consentId;
    await t.test('no unauthenticated access, no CSRF and no cross-origin writes', async () => {
      assert.equal((await fetch(base + '/api/identities')).status, 401);
      await a.call('/deduplicate', {}, 403, { 'X-CSRF-Token': 'invalid' });
      await a.call('/deduplicate', {}, 403, { Origin: 'https://attacker.invalid' });
      const bad = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'officer@ceylon.demo', password: 'wrong' }) });
      assert.equal(bad.status, 401);
    });
    await t.test('dedup matches normalized documents without disclosing PII; registration cannot bypass uniqueness', async () => {
      const result = await b.call('/deduplicate', { country: 'lk', documentType: 'NIC', documentNumber: '1995-1234 5678' });
      assert.equal(result.match.id, ashaId); assert.equal(result.match.accessible, false);
      assert.ok(!JSON.stringify(result).includes('Asha')); assert.ok(!JSON.stringify(result).includes('Flower Road'));
      await b.call('/identities/' + ashaId, undefined, 403);
      const details = await a.call('/identities/' + ashaId);
      await b.call('/identities', { ...details.versions[0].data, customerEmail: 'customer@kyc.demo', processingConsent: true }, 409);
      await c.call('/deduplicate', { country: 'LK', documentType: 'NIC', documentNumber: '199512345678' }, 403);
    });
    await t.test('customer-only approval, version-specific access and successful on-chain reuse', async () => {
      consentId = (await b.call('/consents')).find(x => x.identity === ashaId).id;
      await a.call(`/consents/${consentId}/decision`, { action: 'approve', days: 30 }, 403);
      await b.call(`/identities/${ashaId}/reuse`, { version: 4 }, 403);
      await c.call(`/consents/${consentId}/decision`, { action: 'approve', days: 30 });
      const shared = await b.call('/identities/' + ashaId);
      assert.equal(shared.versions.length, 1); assert.equal(shared.versions[0].version, 4);
      const result = await b.call(`/identities/${ashaId}/reuse`, { version: 4 });
      assert.match(result.tx, /^0x[0-9a-f]{64}$/); assert.ok(result.block > 0);
      await b.call(`/identities/${ashaId}/reuse`, { version: 4 }, 409);
      assert.equal((await a.call(`/identities/${ashaId}/integrity`)).valid, true);
    });
    await t.test('issuer-only mutation, stale-write rejection and old consent cannot expose a new version', async () => {
      const detail = await a.call('/identities/' + ashaId);
      const update = { ...detail.versions[0].data, address: '100 Research Avenue, Colombo', action: 'update', expectedVersion: 4, reason: 'Address updated with customer documentation' };
      await b.call(`/identities/${ashaId}/versions`, update, 403);
      await a.call(`/identities/${ashaId}/versions`, update);
      await a.call(`/identities/${ashaId}/versions`, update, 409);
      const shared = await b.call('/identities/' + ashaId);
      assert.equal(shared.latest, 5); assert.equal(shared.versions[0].version, 4);
      assert.ok(!JSON.stringify(shared).includes('100 Research Avenue'));
      await b.call(`/identities/${ashaId}/reuse`, { version: 4 }, 409);
      await b.call(`/identities/${ashaId}/consents`, { purpose: 'Open an account from updated verification' }, 409);
      await a.call(`/identities/${ashaId}/versions`, { action: 'verify', expectedVersion: 5, reason: 'Updated address verified' });
      await b.call(`/identities/${ashaId}/reuse`, { version: 6 }, 403);
    });
    await t.test('contract independently blocks nonmembers, wrong issuers, stale writes and unconsented reuse', async () => {
      const contract = runtime.chain.contract;
      const latest = await contract.versions(asha.fingerprint, 6);
      const args = [asha.fingerprint, hash('new'), latest.digest, 6, 0];
      await assert.rejects(contract.connect(runtime.chain.wallets[9]).anchor.staticCall(...args), /Member only/);
      await assert.rejects(contract.connect(runtime.chain.wallets[2]).anchor.staticCall(...args), /Issuer only/);
      await assert.rejects(contract.connect(runtime.chain.wallets[1]).anchor.staticCall(asha.fingerprint, hash('new'), latest.digest, 5, 0), /Stale version/);
      await assert.rejects(contract.connect(runtime.chain.wallets[2]).reuse.staticCall(asha.fingerprint, 6), /Consent required/);
      await assert.rejects(contract.connect(runtime.chain.wallets[2]).addMember.staticCall(runtime.chain.wallets[10].address), /Administrator only/);
      await assert.rejects(contract.connect(runtime.chain.wallets[1]).recordConsent.staticCall(asha.fingerprint, runtime.chain.wallets[2].address, 6, true, 1), /Consent expired/);
    });
    await t.test('customer revocation removes previously shared access immediately', async () => {
      await c.call(`/consents/${consentId}/decision`, { action: 'revoke' });
      await b.call('/identities/' + ashaId, undefined, 403);
      assert.ok(!(await b.call('/identities')).some(x => x.id === ashaId));
      const request = await b.call(`/identities/${ashaId}/consents`, { purpose: 'Renew sharing for the new address verification' });
      consentId = request.id;
      await c.call(`/consents/${consentId}/decision`, { action: 'approve', days: 1 });
      assert.equal((await b.call('/identities/' + ashaId)).versions[0].version, 6);
    });
    await t.test('encrypted snapshots, GCM tamper detection and on-chain receipt checks', async () => {
      const row = runtime.service.version(ashaId, 6);
      assert.ok(!row.ciphertext.includes('Research Avenue'));
      runtime.db.prepare('UPDATE versions SET ciphertext=? WHERE identity=? AND version=?').run(row.ciphertext.slice(0, -2) + (row.ciphertext.endsWith('00') ? 'ff' : '00'), ashaId, 6);
      assert.equal((await a.call(`/identities/${ashaId}/integrity`)).valid, false);
      runtime.db.prepare('UPDATE versions SET ciphertext=? WHERE identity=? AND version=?').run(row.ciphertext, ashaId, 6);
      runtime.db.prepare('UPDATE versions SET tx=? WHERE identity=? AND version=?').run(hash('nonexistent'), ashaId, 6);
      assert.equal((await a.call(`/identities/${ashaId}/integrity`)).valid, false);
      runtime.db.prepare('UPDATE versions SET tx=? WHERE identity=? AND version=?').run(row.tx, ashaId, 6);
      assert.equal((await a.call(`/identities/${ashaId}/integrity`)).valid, true);
    });
    await t.test('new customer, evidence download protection, validation and concurrent duplicate race', async () => {
      const input = { fullName: 'Test Customer', country: 'LK', documentType: 'PASSPORT', documentNumber: 'N-1234567', expiresOn: '2035-12-31', dateOfBirth: '1992-04-11', nationality: 'Sri Lankan', address: '44 Test Street, Colombo', phone: '+94 77 123 4567', email: 'test@example.test', customerEmail: 'new-customer@example.test', processingConsent: true, evidence: { name: 'synthetic.pdf', type: 'application/pdf', base64: Buffer.from('%PDF-1.4\nsynthetic test fixture').toString('base64') } };
      await a.call('/identities', { ...input, dateOfBirth: '1992-02-31' }, 400);
      await a.call('/identities', { ...input, evidence: { name: 'bad.pdf', type: 'application/pdf', base64: Buffer.from('invalid').toString('base64') } }, 400);
      const results = await Promise.all([a.call('/identities', input), b.call('/identities', input, 409)]);
      const created = results[0]; assert.ok(created.temporaryPassword);
      const customer = await client(created.customerEmail, created.temporaryPassword);
      assert.equal((await customer.call('/identities/' + created.id)).versions[0].data.fullName, input.fullName);
      const unauthorized = await fetch(`${base}/api/identities/${created.id}/evidence/1`, { headers: { Cookie: b.cookie } }); assert.equal(unauthorized.status, 403);
      const authorized = await fetch(`${base}/api/identities/${created.id}/evidence/1`, { headers: { Cookie: customer.cookie } }); assert.equal(authorized.status, 200); assert.ok((await authorized.text()).startsWith('%PDF-'));
      await a.call(`/identities/${created.id}/versions`, { ...input, documentNumber: 'N9999999', action: 'update', expectedVersion: 1, reason: 'Change document number' }, 400);
    });
    await t.test('administrator onboarding adds a contract-authorized account but does not expose PII', async () => {
      await a.call('/institutions', { name: 'Research Bank', code: 'RSB', email: 'officer@research.test' }, 403);
      const created = await admin.call('/institutions', { name: 'Research Bank', code: 'RSB', email: 'officer@research.test' });
      const officer = await client(created.email, created.temporaryPassword);
      assert.equal(officer.user.role, 'institution');
      const institution = runtime.service.institution(created.id);
      assert.equal(await runtime.chain.contract.members(institution.address), true);
      await admin.call('/identities/' + ashaId, undefined, 403);
    });
    await t.test('identity revocation is final and blocks sharing and contract reuse', async () => {
      await a.call(`/identities/${ashaId}/versions`, { action: 'revoke', expectedVersion: 6, reason: 'Research scenario: identity document withdrawn' });
      await b.call('/identities/' + ashaId, undefined, 403);
      await a.call(`/identities/${ashaId}/versions`, { action: 'verify', expectedVersion: 7, reason: 'Attempt to reactivate revoked record' }, 409);
      await assert.rejects(runtime.chain.contract.connect(runtime.chain.wallets[2]).reuse.staticCall(asha.fingerprint, 6), /Verification stale or revoked/);
    });
    await t.test('confirmed blockchain write survives a database commit failure through outbox recovery', async () => {
      const pending = runtime.db.prepare("SELECT i.* FROM identities i JOIN versions v ON i.id=v.identity AND i.latest=v.version WHERE i.owner='bank-a' AND v.status='pending' LIMIT 1").get();
      const before = pending.latest;
      runtime.db.exec("CREATE TRIGGER simulate_disk_failure BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT, 'simulated commit failure'); END;");
      await assert.rejects(runtime.service.write(() => runtime.service.update(a.user, pending.id, { action: 'verify', expectedVersion: before, reason: 'Recovery scenario verification' })), /simulated commit failure/);
      assert.equal(runtime.service.identity(pending.id).latest, before);
      assert.equal(Number((await runtime.chain.contract.identities(pending.fingerprint)).latest), before + 1);
      assert.equal(runtime.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='prepared'").get().n, 1);
      runtime.db.exec('DROP TRIGGER simulate_disk_failure');
      const address = await runtime.chain.contract.getAddress();
      await stop(); runtime = null; server = null;
      await start();
      assert.equal(await runtime.chain.contract.getAddress(), address);
      assert.equal(runtime.service.identity(pending.id).latest, before + 1);
      assert.equal(runtime.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='prepared'").get().n, 0);
      assert.equal((await runtime.service.integrity(runtime.service.user('bank-a-officer'), pending.id)).valid, true);
      a = await client('officer@ceylon.demo');
      assert.equal((await a.call('/identities/' + ashaId)).currentStatus, 'revoked');
    });
  } finally { await stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});
