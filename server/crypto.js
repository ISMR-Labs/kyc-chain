import { randomBytes, createCipheriv, createDecipheriv, createHmac, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

export const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
export const hash = value => '0x' + createHash('sha256').update(value).digest('hex');
export const normalizeDocument = value => String(value).normalize('NFKC').toUpperCase().replace(/[\s-]/g, '');
export const fingerprint = (keys, data) => '0x' + createHmac('sha256', Buffer.from(keys.index, 'hex')).update(canonical([data.country, data.documentType, normalizeDocument(data.documentNumber)])).digest('hex');
export function encrypt(keys, value, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keys.encryption, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(canonical(value)), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join('.');
}
export function decrypt(keys, value, context) {
  const [iv, tag, ciphertext] = value.split('.').map(x => Buffer.from(x, 'hex'));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keys.encryption, 'hex'), iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString());
}
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
export function checkPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, 'hex'));
}
