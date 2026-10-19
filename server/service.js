import { randomBytes, randomUUID } from 'node:crypto';
import { ZeroHash } from 'ethers';
import { canonical, hash, fingerprint, normalizeDocument, encrypt, decrypt, passwordHash } from './crypto.js';

const now = () => new Date().toISOString();
const q = (sql, ...params) => ({ sql, params });
const statusCode = { pending: 0, verified: 1, revoked: 2 };
export class AppError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
export function requireValue(condition, status, message, details) { if (!condition) throw new AppError(status, message, details); }
function text(value, label, min = 1, max = 200) {
  requireValue(typeof value === 'string' && value.trim().length >= min && value.trim().length <= max, 400, `${label} must contain ${min}–${max} characters.`);
  return value.trim();
}
function date(value, label) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 400, `${label} must be a valid date.`);
  return value;
}
function evidence(value, existing) {
  if (value === undefined) return existing ?? null;
  if (value === null) return null;
  requireValue(value && typeof value === 'object', 400, 'Evidence must be a PDF, PNG or JPEG file.');
  const name = text(value.name, 'File name', 1, 120);
  requireValue(['application/pdf', 'image/png', 'image/jpeg'].includes(value.type), 400, 'Only PDF, PNG and JPEG evidence is supported.');
  requireValue(typeof value.base64 === 'string' && value.base64.length <= 2800000 && /^[A-Za-z0-9+/]*={0,2}$/.test(value.base64), 400, 'Evidence must be at most 2 MB.');
  const bytes = Buffer.from(value.base64, 'base64');
  requireValue(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024, 400, 'Evidence must be at most 2 MB.');
  const magic = value.type === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : value.type === 'image/png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' : bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
  requireValue(magic, 400, 'The evidence content does not match its file type.');
  return { name, type: value.type, base64: bytes.toString('base64'), sha256: hash(bytes), size: bytes.length };
}
function profile(input, existing) {
  const data = {
    fullName: text(input.fullName, 'Full name', 3, 100),
    dateOfBirth: date(input.dateOfBirth, 'Date of birth'),
    country: text(input.country, 'Issuing country', 2, 2).toUpperCase(),
    nationality: text(input.nationality, 'Nationality', 2, 60),
    documentType: text(input.documentType, 'Document type'),
    documentNumber: normalizeDocument(text(input.documentNumber, 'Document number', 4, 32)),
    expiresOn: date(input.expiresOn, 'Document expiry'),
    address: text(input.address, 'Address', 5, 300),
    phone: text(input.phone, 'Phone', 7, 30),
    email: text(input.email, 'Email', 5, 120).toLowerCase(),
    evidence: evidence(input.evidence, existing?.evidence)
  };
  requireValue(/^[A-Z]{2}$/.test(data.country) && ['NIC', 'PASSPORT', 'DRIVING_LICENSE'].includes(data.documentType), 400, 'Select a valid document type and two-letter country code.');
  requireValue(/^[A-Z0-9]{4,32}$/.test(data.documentNumber), 400, 'Document numbers may contain letters, numbers, spaces and hyphens.');
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email), 400, 'Enter a valid email address.');
  requireValue(data.dateOfBirth >= '1900-01-01' && data.dateOfBirth <= now().slice(0, 10), 400, 'Date of birth must be between 1900 and today.');
  requireValue(data.expiresOn >= data.dateOfBirth, 400, 'Expiry must be after the date of birth.');
  return data;
}

export class KYCService {
  constructor(db, keys, chain) { Object.assign(this, { db, keys, chain }); this.tail = Promise.resolve(); }
  write(task) { const result = this.tail.then(task); this.tail = result.catch(() => {}); return result; }
  user(id) { return this.db.prepare('SELECT id,email,name,role,institution,must_change_password FROM users WHERE id=?').get(id); }
  institution(id) { return this.db.prepare('SELECT * FROM institutions WHERE id=?').get(id); }
  member(actor) { requireValue(actor.role === 'institution', 403, 'An institution officer account is required.'); return this.institution(actor.institution); }
  identity(id) { const item = this.db.prepare('SELECT * FROM identities WHERE id=?').get(id); requireValue(item, 404, 'Identity not found.'); return item; }
  version(id, version) { return this.db.prepare('SELECT * FROM versions WHERE identity=? AND version=?').get(id, version); }
  payload(row) { return decrypt(this.keys, row.ciphertext, `${row.identity}:${row.version}`); }
  audit(actor, action, identity, detail, onChain = false) {
    return q('INSERT INTO audit(actor,institution,action,identity,detail,created,tx,block) VALUES (?,?,?,?,?,?,?,?)', actor.id, actor.institution ?? null, action, identity ?? null, detail, now(), onChain ? '$TX' : null, onChain ? '$BLOCK' : null);
  }
  run(query) { return this.db.prepare(query.sql).run(...query.params); }
  allowed(actor, item) {
    if (actor.institution === item.owner || actor.id === item.customer) return Array.from({ length: item.latest }, (_, i) => i + 1);
    if (actor.role !== 'institution' || this.version(item.id, item.latest).status === 'revoked') return [];
    return this.db.prepare("SELECT DISTINCT version FROM consents WHERE identity=? AND requester=? AND state='approved' AND expires>?").all(item.id, actor.institution, now()).map(x => x.version);
  }
  serialize(row) {
    const payload = this.payload(row);
    const data = { ...payload.data };
    if (data.evidence) { const { base64, ...metadata } = data.evidence; data.evidence = metadata; }
    return { version: row.version, digest: row.digest, previous: row.previous, status: row.status, reason: row.reason, created: row.created, tx: row.tx, block: row.block, data };
  }
  detail(actor, id, audit = true) {
    const item = this.identity(id);
    const versions = this.allowed(actor, item);
    requireValue(versions.length, 403, 'An active customer consent is required to view this identity.');
    const current = this.version(id, item.latest);
    if (audit) this.run(this.audit(actor, 'RECORD_VIEWED', id, 'Authorized encrypted record read'));
    return { id, owner: this.institution(item.owner), customer: actor.institution === item.owner ? this.user(item.customer) : undefined, latest: item.latest, currentStatus: current.status, owned: actor.institution === item.owner, versions: versions.map(v => this.serialize(this.version(id, v))).reverse(), reuses: this.db.prepare('SELECT r.*,i.name AS institutionName FROM reuses r JOIN institutions i ON i.id=r.institution WHERE identity=? AND (r.institution=? OR ?=1)').all(id, actor.institution ?? '', actor.institution === item.owner || actor.id === item.customer ? 1 : 0) };
  }
  list(actor) {
    return this.db.prepare('SELECT * FROM identities ORDER BY created DESC').all().flatMap(item => {
      const access = this.allowed(actor, item);
      if (!access.length) return [];
      const row = this.version(item.id, Math.max(...access));
      const data = this.payload(row).data;
      return [{ id: item.id, fullName: data.fullName, documentType: data.documentType, maskedDocument: '•••• ' + data.documentNumber.slice(-4), owner: this.institution(item.owner).name, ownerId: item.owner, owned: item.owner === actor.institution, latest: item.latest, visibleVersion: row.version, status: this.version(item.id, item.latest).status, expiresOn: data.expiresOn, updated: row.created }];
    });
  }
  async deduplicate(actor, input) {
    this.member(actor);
    const documentNumber = normalizeDocument(text(input.documentNumber, 'Document number', 4, 32));
    const country = text(input.country, 'Country', 2, 2).toUpperCase();
    const documentType = text(input.documentType, 'Document type');
    requireValue(/^[A-Z0-9]{4,32}$/.test(documentNumber) && /^[A-Z]{2}$/.test(country) && ['NIC', 'PASSPORT', 'DRIVING_LICENSE'].includes(documentType), 400, 'Invalid document identifier.');
    const key = fingerprint(this.keys, { country, documentType, documentNumber });
    const item = this.db.prepare('SELECT * FROM identities WHERE fingerprint=?').get(key);
    this.run(this.audit(actor, item ? 'DUPLICATE_DETECTED' : 'DEDUP_CLEAR', item?.id, item ? 'Exact normalized document match' : 'No matching document fingerprint'));
    return { match: item ? { id: item.id, owner: this.institution(item.owner).name, ownerId: item.owner, version: item.latest, status: this.version(item.id, item.latest).status, owned: item.owner === actor.institution, accessible: this.allowed(actor, item).length > 0 } : null, method: 'HMAC-SHA-256 / exact normalized document match' };
  }
  async anchor(actor, item, data, status, reason, extra = []) {
    const institution = this.institution(item.owner);
    const version = item.latest + 1;
    const previous = item.latest ? this.version(item.id, item.latest).digest : ZeroHash;
    const created = now();
    const payload = { identity: item.id, version, previous, status, reason, created, data, nonce: randomBytes(32).toString('hex') };
    const digest = hash(canonical(payload));
    const ciphertext = encrypt(this.keys, payload, `${item.id}:${version}`);
    const queries = [...extra, q('INSERT INTO versions(identity,version,ciphertext,digest,previous,status,reason,created,tx,block) VALUES (?,?,?,?,?,?,?,?,?,?)', item.id, version, ciphertext, digest, previous, status, reason, created, '$TX', '$BLOCK'), q('UPDATE identities SET latest=? WHERE id=?', version, item.id), this.audit(actor, status === 'verified' ? 'KYC_VERIFIED' : status === 'revoked' ? 'IDENTITY_REVOKED' : version === 1 ? 'IDENTITY_CREATED' : 'VERSION_CREATED', item.id, `Version ${version}: ${status}`, true)];
    return { ...(await this.chain.transact(institution.slot, 'anchor', [item.fingerprint, digest, previous, item.latest, statusCode[status]], queries)), id: item.id, version };
  }
  async create(actor, input) {
    this.member(actor);
    const data = profile(input);
    const key = fingerprint(this.keys, data);
    const duplicate = this.db.prepare('SELECT id FROM identities WHERE fingerprint=?').get(key);
    requireValue(!duplicate, 409, 'This document is already registered. Request consent to reuse the existing verification.', { identity: duplicate?.id });
    requireValue(input.processingConsent === true, 400, 'Record the customer’s permission to process this KYC submission.');
    const customerEmail = text(input.customerEmail, 'Customer portal email', 5, 120).toLowerCase();
    requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail), 400, 'Enter a valid customer portal email.');
    let customer = this.db.prepare('SELECT * FROM users WHERE email=?').get(customerEmail);
    requireValue(!customer || customer.role === 'customer', 400, 'That email belongs to an institution or administrator account.');
    const extra = [];
    let temporaryPassword;
    if (!customer) {
      temporaryPassword = randomBytes(12).toString('base64url');
      customer = { id: randomUUID() };
      extra.push(q('INSERT INTO users(id,email,name,password,role,institution) VALUES (?,?,?,?,?,?)', customer.id, customerEmail, data.fullName, passwordHash(temporaryPassword), 'customer', null));
      if (this.hardened) extra.push(q('UPDATE users SET must_change_password=1 WHERE id=?', customer.id));
    }
    const item = { id: randomUUID(), fingerprint: key, owner: actor.institution, customer: customer.id, latest: 0 };
    extra.push(q('INSERT INTO identities(id,fingerprint,owner,customer,latest,created) VALUES (?,?,?,?,?,?)', item.id, key, item.owner, item.customer, 0, now()));
    const result = await this.anchor(actor, item, data, 'pending', 'Initial KYC submission; processing consent attested by officer', extra);
    return { ...result, customerEmail, temporaryPassword };
  }
  async update(actor, id, input) {
    this.member(actor);
    const item = this.identity(id);
    requireValue(item.owner === actor.institution, 403, 'Only the issuing institution may change a record.');
    requireValue(Number.isInteger(input.expectedVersion) && input.expectedVersion === item.latest, 409, 'The record changed. Refresh it before submitting.');
    const row = this.version(id, item.latest);
    requireValue(row.status !== 'revoked', 409, 'Revoked identities are read-only.');
    const current = this.payload(row).data;
    const action = input.action || 'update';
    requireValue(['update', 'verify', 'revoke'].includes(action), 400, 'Unknown version action.');
    const reason = text(input.reason, 'Change reason', 5, 300);
    const data = action === 'update' ? profile(input, current) : current;
    requireValue(fingerprint(this.keys, data) === item.fingerprint, 400, 'Document identity fields cannot be changed. Register a different document separately.');
    if (action === 'verify') {
      requireValue(row.status === 'pending', 409, 'Only a pending version may be verified.');
      requireValue(data.expiresOn >= now().slice(0, 10), 400, 'Expired documents cannot be verified.');
    }
    if (action === 'update') requireValue(canonical(data) !== canonical(current), 400, 'Change at least one field before creating a version.');
    return this.anchor(actor, item, data, action === 'verify' ? 'verified' : action === 'revoke' ? 'revoked' : 'pending', reason);
  }
  consents(actor) {
    return this.db.prepare('SELECT c.*,i.owner,i.customer,o.name AS ownerName,r.name AS requesterName FROM consents c JOIN identities i ON c.identity=i.id JOIN institutions o ON i.owner=o.id JOIN institutions r ON c.requester=r.id ORDER BY c.created DESC').all().filter(c => actor.role === 'admin' || c.customer === actor.id || c.owner === actor.institution || c.requester === actor.institution).map(c => ({ ...c, state: c.state === 'approved' && c.expires <= now() ? 'expired' : c.state, latest: this.identity(c.identity).latest }));
  }
  async requestConsent(actor, id, input) {
    this.member(actor);
    const item = this.identity(id);
    requireValue(item.owner !== actor.institution, 400, 'Your institution already owns this record.');
    requireValue(this.version(id, item.latest).status === 'verified', 409, 'The issuing institution must verify the latest version before you request reuse.');
    const purpose = text(input.purpose, 'Purpose', 10, 300);
    const open = this.db.prepare("SELECT * FROM consents WHERE identity=? AND requester=? AND version=? AND (state='pending' OR (state='approved' AND expires>?))").get(id, actor.institution, item.latest, now());
    requireValue(!open, 409, 'A request or active consent already exists for this version.');
    const consentId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.run(q('INSERT INTO consents(id,identity,requester,version,purpose,state,created) VALUES (?,?,?,?,?,?,?)', consentId, id, actor.institution, item.latest, purpose, 'pending', now()));
      this.run(this.audit(actor, 'CONSENT_REQUESTED', id, `Version ${item.latest}; request ${consentId}`));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id: consentId };
  }
  async decideConsent(actor, id, input) {
    const consent = this.db.prepare('SELECT * FROM consents WHERE id=?').get(id);
    requireValue(consent, 404, 'Consent request not found.');
    const item = this.identity(consent.identity);
    requireValue(actor.role === 'customer' && actor.id === item.customer, 403, 'Only the customer may approve, reject or revoke consent.');
    requireValue(['approve', 'reject', 'revoke'].includes(input.action), 400, 'Choose approve, reject or revoke.');
    requireValue(input.action === 'revoke' ? consent.state === 'approved' : consent.state === 'pending', 409, 'This request has already been decided.');
    if (input.action === 'reject') {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.run(q('UPDATE consents SET state=? WHERE id=?', 'rejected', id));
        this.run(this.audit(actor, 'CONSENT_REJECTED', item.id, `Request ${id}`));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      return { state: 'rejected' };
    }
    const active = input.action === 'approve';
    if (active) requireValue(item.latest === consent.version && this.version(item.id, item.latest).status === 'verified', 409, 'This request is stale. Ask the institution to request the latest verified version.');
    const days = input.days ?? 30;
    requireValue(!active || (Number.isInteger(days) && days >= 1 && days <= 90), 400, 'Consent duration must be 1–90 days.');
    const expires = active ? new Date(Date.now() + days * 86400000).toISOString() : consent.expires;
    const state = active ? 'approved' : 'revoked';
    const owner = this.institution(item.owner);
    const recipient = this.institution(consent.requester);
    // One active grant per institution; revoke all older grants when replacing it.
    const queries = [q("UPDATE consents SET state='revoked' WHERE identity=? AND requester=? AND state='approved'", item.id, consent.requester), q('UPDATE consents SET state=?,expires=?,tx=? WHERE id=?', state, expires, '$TX', id), this.audit(actor, active ? 'CONSENT_APPROVED' : 'CONSENT_REVOKED', item.id, `Version ${consent.version}; request ${id}`, true)];
    return { state, ...(await this.chain.transact(owner.slot, 'recordConsent', [item.fingerprint, recipient.address, consent.version, active, Math.floor(Date.parse(expires) / 1000)], queries)) };
  }
  async reuse(actor, id, input) {
    const recipient = this.member(actor);
    const item = this.identity(id);
    requireValue(Number.isInteger(input.version) && input.version === item.latest, 409, 'Only the latest version can be reused.');
    requireValue(this.allowed(actor, item).includes(item.latest) && item.owner !== actor.institution, 403, 'Active customer consent for this version is required.');
    const row = this.version(id, item.latest);
    requireValue(row.status === 'verified' && this.payload(row).data.expiresOn >= now().slice(0, 10), 409, 'Only a current, unexpired verified record can be reused.');
    requireValue(!this.db.prepare('SELECT id FROM reuses WHERE identity=? AND institution=? AND version=?').get(id, actor.institution, item.latest), 409, 'Your institution has already reused this version.');
    const check = await this.integrity(actor, id);
    requireValue(check.valid, 409, 'Integrity check failed. This record cannot be reused.');
    const queries = [q('INSERT INTO reuses(id,identity,institution,version,created,tx,block) VALUES (?,?,?,?,?,?,?)', randomUUID(), id, actor.institution, item.latest, now(), '$TX', '$BLOCK'), this.audit(actor, 'VERIFICATION_REUSED', id, `Version ${item.latest}`, true)];
    return this.chain.transact(recipient.slot, 'reuse', [item.fingerprint, item.latest], queries);
  }
  async integrity(actor, id) {
    const item = this.identity(id);
    const permitted = this.allowed(actor, item);
    requireValue(permitted.length, 403, 'Consent or ownership is required to inspect record integrity.');
    const chainIdentity = await this.chain.contract.identities(item.fingerprint);
    const institution = this.institution(item.owner);
    let valid = Number(chainIdentity.latest) === item.latest && chainIdentity.issuer.toLowerCase() === institution.address.toLowerCase();
    const checks = [];
    for (const number of permitted) {
      const row = this.version(id, number);
      const anchor = await this.chain.contract.versions(item.fingerprint, number);
      let digestMatch = false, metadataMatch = false;
      try {
        const payload = this.payload(row);
        digestMatch = hash(canonical(payload)) === row.digest && row.digest === anchor.digest;
        metadataMatch = payload.identity === id && payload.version === number && payload.previous === row.previous && payload.status === row.status && payload.reason === row.reason && payload.created === row.created && fingerprint(this.keys, payload.data) === item.fingerprint;
      } catch { /* GCM detects ciphertext tampering. */ }
      const predecessor = number === 1 ? ZeroHash : (await this.chain.contract.versions(item.fingerprint, number - 1)).digest;
      const linkMatch = row.previous === anchor.previousDigest && row.previous === predecessor;
      const statusMatch = statusCode[row.status] === Number(anchor.status);
      const receipt = await this.chain.provider.getTransactionReceipt(row.tx);
      const receiptMatch = receipt?.status === 1 && receipt.blockNumber === row.block && receipt.to?.toLowerCase() === (await this.chain.contract.getAddress()).toLowerCase() && receipt.logs.some(log => {
        try { const event = this.chain.contract.interface.parseLog(log); return event?.name === 'VersionAnchored' && event.args.identity === item.fingerprint && Number(event.args.version) === number && event.args.digest === row.digest; } catch { return false; }
      });
      const ok = digestMatch && metadataMatch && linkMatch && statusMatch && receiptMatch;
      valid = valid && ok;
      checks.push({ version: number, valid: Boolean(ok), digestMatch, metadataMatch, linkMatch, statusMatch, receiptMatch: Boolean(receiptMatch), block: row.block });
    }
    this.run(this.audit(actor, 'INTEGRITY_CHECKED', id, valid ? 'All accessible version commitments match the blockchain' : 'Integrity mismatch detected'));
    return { valid: Boolean(valid), chainLatest: Number(chainIdentity.latest), checked: checks.length, checks };
  }
  auditLog(actor) {
    const rows = this.db.prepare('SELECT a.*,u.name AS actorName,i.name AS institutionName FROM audit a JOIN users u ON u.id=a.actor LEFT JOIN institutions i ON i.id=a.institution ORDER BY a.id DESC LIMIT 1000').all();
    return rows.filter(row => actor.role === 'admin' || row.actor === actor.id || row.institution === actor.institution || (row.identity && this.db.prepare('SELECT id FROM identities WHERE id=? AND (owner=? OR customer=?)').get(row.identity, actor.institution ?? '', actor.id))).slice(0, 150);
  }
  async network() {
    const address = await this.chain.contract.getAddress();
    return { chainId: 202610, name: 'KYC Consortium', contract: address, block: await this.chain.provider.getBlockNumber(), institutions: this.db.prepare('SELECT * FROM institutions ORDER BY slot').all(), confirmed: this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='committed'").get().n, pending: this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='prepared'").get().n, mode: this.chain.mode, compiler: 'Solidity 0.8.37' };
  }
  async dashboard(actor) {
    const records = this.list(actor);
    const consents = this.consents(actor);
    const audit = this.auditLog(actor);
    return { records, consents, audit: audit.slice(0, 8), stats: { records: records.length, verified: records.filter(r => r.status === 'verified').length, pending: consents.filter(c => c.state === 'pending').length, reused: this.db.prepare('SELECT COUNT(*) AS n FROM reuses WHERE institution=? OR ?=1').get(actor.institution ?? '', actor.role === 'admin' ? 1 : 0).n, duplicates: this.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='DUPLICATE_DETECTED' AND (institution=? OR ?=1)").get(actor.institution ?? '', actor.role === 'admin' ? 1 : 0).n }, network: await this.network() };
  }
  async addInstitution(actor, input) {
    requireValue(actor.role === 'admin', 403, 'Only the consortium administrator can onboard institutions.');
    const name = text(input.name, 'Institution name', 3, 80);
    const code = text(input.code, 'Institution code', 2, 8).toUpperCase();
    requireValue(/^[A-Z0-9]+$/.test(code), 400, 'Institution code must contain letters and numbers.');
    const email = text(input.email, 'Officer email', 5, 120).toLowerCase();
    requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 400, 'Enter a valid email address.');
    requireValue(!this.db.prepare('SELECT id FROM users WHERE email=?').get(email) && !this.db.prepare('SELECT id FROM institutions WHERE code=?').get(code), 409, 'That institution code or officer email already exists.');
    const slot = this.db.prepare('SELECT COALESCE(MAX(slot),0)+1 AS slot FROM institutions').get().slot;
    requireValue(slot < this.chain.wallets.length, 409, 'The local demonstration supports up to 19 institutions.');
    const id = randomUUID();
    const address = this.chain.wallets[slot].address;
    const temporaryPassword = randomBytes(12).toString('base64url');
    const queries = [q('INSERT INTO institutions(id,name,code,address,slot) VALUES (?,?,?,?,?)', id, name, code, address, slot), q('INSERT INTO users(id,email,name,password,role,institution) VALUES (?,?,?,?,?,?)', randomUUID(), email, name + ' Officer', passwordHash(temporaryPassword), 'institution', id), this.audit(actor, 'INSTITUTION_ADDED', null, `Consortium member ${code}`, true)];
    if (this.hardened) queries.push(q('UPDATE users SET must_change_password=1 WHERE email=?', email));
    await this.chain.transact(0, 'addMember', [address], queries);
    return { id, email, temporaryPassword };
  }
}

export async function seed(service) {
  const { db, chain } = service;
  if (db.prepare("SELECT value FROM settings WHERE key='seeded'").get()) return;
  const demoPassword = passwordHash('Demo@12345');
  db.prepare('INSERT OR IGNORE INTO users(id,email,name,password,role,institution) VALUES (?,?,?,?,?,?)').run('admin', 'admin@kyc.demo', 'Consortium Administrator', demoPassword, 'admin', null);
  const institutions = [['bank-a', 'Ceylon Trust Bank', 'CTB', 'officer@ceylon.demo'], ['bank-b', 'Serendib Finance', 'SDF', 'officer@serendib.demo'], ['bank-c', 'Lanka Digital Bank', 'LDB', 'officer@lanka.demo']];
  for (const [index, [id, name, code, email]] of institutions.entries()) {
    if (service.institution(id)) continue;
    await chain.transact(0, 'addMember', [chain.wallets[index + 1].address], [q('INSERT INTO institutions(id,name,code,address,slot) VALUES (?,?,?,?,?)', id, name, code, chain.wallets[index + 1].address, index + 1), q('INSERT INTO users(id,email,name,password,role,institution) VALUES (?,?,?,?,?,?)', id + '-officer', email, name + ' Officer', demoPassword, 'institution', id)]);
  }
  db.prepare('INSERT OR IGNORE INTO users(id,email,name,password,role,institution) VALUES (?,?,?,?,?,?)').run('customer', 'customer@kyc.demo', 'Asha Senanayake', demoPassword, 'customer', null);
  const samples = [
    ['Asha Senanayake', '199512345678', 'bank-a', 'customer@kyc.demo', '1995-05-14', '24 Temple Road, Colombo 05', 'verified'],
    ['Nimal Jayawardena', '198812345679', 'bank-a', 'nimal@kyc.demo', '1988-02-20', '18 Lake Road, Kandy', 'verified'],
    ['Kavindi Perera', '199912345680', 'bank-a', 'kavindi@kyc.demo', '1999-09-08', '72 Galle Road, Dehiwala', 'pending'],
    ['Ravi Fernando', '199012345681', 'bank-b', 'ravi@kyc.demo', '1990-03-11', '6 Park Avenue, Galle', 'verified'],
    ['Amaya Silva', '199712345682', 'bank-c', 'amaya@kyc.demo', '1997-07-23', '11 Station Road, Negombo', 'verified']
  ];
  for (const [fullName, documentNumber, owner, email, dateOfBirth, address, status] of samples) {
    const actor = service.user(owner + '-officer');
    const data = { fullName, documentNumber, country: 'LK', documentType: 'NIC', nationality: 'Sri Lankan', dateOfBirth, address, email, phone: '+94 77 000 0000', expiresOn: '2032-12-31', customerEmail: email, processingConsent: true };
    const existing = db.prepare('SELECT id,latest FROM identities WHERE fingerprint=?').get(fingerprint(service.keys, data));
    const created = existing || await service.create(actor, data);
    if (status === 'verified' && service.identity(created.id).latest === 1) await service.update(actor, created.id, { action: 'verify', expectedVersion: 1, reason: 'Synthetic demo documents reviewed by issuing institution' });
  }
  const asha = db.prepare('SELECT * FROM identities WHERE customer=?').get('customer');
  const owner = service.user('bank-a-officer');
  if (asha.latest === 2) {
    const data = service.payload(service.version(asha.id, asha.latest)).data;
    await service.update(owner, asha.id, { ...data, address: '42 Flower Road, Colombo 07', expectedVersion: 2, reason: 'Customer submitted updated residential address' });
  }
  if (service.identity(asha.id).latest === 3) await service.update(owner, asha.id, { action: 'verify', expectedVersion: 3, reason: 'Updated address evidence reviewed and accepted' });
  const requests = db.prepare('SELECT id FROM consents WHERE identity=?').all(asha.id);
  if (!requests.length) await service.requestConsent(service.user('bank-b-officer'), asha.id, { purpose: 'Open a savings account using your verified KYC record' });
  db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('seeded', '1');
}
