# HTTP API

Base URL: `http://127.0.0.1:4310/api`

All request/response payloads are JSON except evidence downloads. Mutations require `Content-Type: application/json`. After login, send the `kyc_session` cookie and the returned CSRF value in `X-CSRF-Token` for every POST. Browser requests do this automatically. The API does not expose CORS access to other origins.

Errors use `{ "error": "Human-readable message", "details": { ... } }`; `details` is optional. Typical statuses: 400 invalid data, 401 no valid session, 403 unauthorized, 404 absent resource, 409 duplicate/stale state, 413 oversized request, 415 wrong content type, 429 throttled login, 500 unexpected/recovery-needed failure.

## Authentication

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Unauthenticated process health |
| POST | `/login` | Email/password → user + CSRF, session cookie |
| GET | `/me` | Current user + CSRF |
| POST | `/logout` | Invalidate current session |
| POST | `/account/password` | Current password + new 14–200 character password; rotate sessions |

```json
{ "email": "officer@ceylon.demo", "password": "Demo@12345" }
```

Sessions persist across controlled server restarts, expire after eight hours or 30 minutes idle, and are revoked by password changes. New hosted accounts must change their temporary password before calling workspace endpoints.

## Identity workflows

| Method | Path | Authorization / behavior |
| --- | --- | --- |
| GET | `/dashboard` | Role-filtered records, consent, metrics, recent audit and network |
| POST | `/deduplicate` | Institution only; exact document match metadata |
| GET | `/identities` | Authorized records only, with masked document suffix |
| POST | `/identities` | Institution creates pending identity and optional customer account |
| GET | `/identities/:id` | Owner/customer: full history; recipient: active approved version only |
| POST | `/identities/:id/versions` | Issuer only; update, verify or revoke |
| GET | `/identities/:id/integrity` | Authorized accessible-version verification against chain |
| GET | `/identities/:id/evidence/:version` | Authorized attachment download |
| POST | `/identities/:id/reuse` | Recipient with current verified, unexpired, consented version |

### Duplicate lookup

```json
{ "country": "LK", "documentType": "NIC", "documentNumber": "1995-1234 5678" }
```

The response has `match: null` or `match: { id, owner, ownerId, version, status, owned, accessible }`, plus the matching method. No personal profile is returned.

### Registration

```json
{
  "fullName": "Synthetic Customer",
  "dateOfBirth": "1995-05-14",
  "country": "LK",
  "nationality": "Sri Lankan",
  "documentType": "NIC",
  "documentNumber": "199512345699",
  "expiresOn": "2032-12-31",
  "address": "12 Demonstration Road, Colombo",
  "phone": "+94 77 000 1111",
  "email": "synthetic@example.test",
  "customerEmail": "synthetic@example.test",
  "processingConsent": true
}
```

Allowed document types: `NIC`, `PASSPORT`, `DRIVING_LICENSE`. The backend accepts two-letter issuing-country codes. An optional `evidence` field contains `{ name, type, base64 }`. The server computes its digest and size and validates basic file signatures. Limit: 2 MB decoded bytes.

The response contains `{ id, version, tx, block, customerEmail }`, and `temporaryPassword` only for a newly created customer account. Existing customer accounts can control more than one registered document. Linking to an existing email is an officer attestation in this prototype; email ownership verification is not implemented.

### Updating an identity

Send all editable profile fields and:

```json
{ "action": "update", "expectedVersion": 4, "reason": "Customer changed residential address" }
```

Country, document type and document number cannot change. Omit `evidence` to preserve the existing file; `null` removes it. Any update creates a new pending version. No-op changes are rejected. `expectedVersion` must match the current latest version.

### Verification / revocation

```json
{ "action": "verify", "expectedVersion": 5, "reason": "Updated document reviewed and accepted" }
```

```json
{ "action": "revoke", "expectedVersion": 6, "reason": "Document withdrawn by the customer" }
```

Verification requires a pending, unexpired snapshot. Revocation is final for this identity. Both operations append a version and return its transaction receipt metadata.

### Reuse

```json
{ "version": 6 }
```

One reuse receipt per identity/institution/version. Consent, latest version, verified status, profile expiry and integrity are checked before signing the recipient transaction. The contract independently enforces member, latest version, status and on-chain grant checks.

## Consent

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/consents` | Requests visible to customer, issuer, recipient or administrator |
| POST | `/identities/:id/consents` | Recipient requests latest verified version |
| POST | `/consents/:id/decision` | Linked customer approves, rejects or revokes |

Request:

```json
{ "purpose": "Open a savings account using the existing verified KYC record" }
```

Approve:

```json
{ "action": "approve", "days": 30 }
```

Reject or revoke:

```json
{ "action": "reject" }
```

```json
{ "action": "revoke" }
```

Durations are whole numbers from 1 to 90 days. Approvals must refer to the latest verified version. Rejection has no on-chain access grant to revoke and remains an off-chain audit event. Approval/revocation transactions are relayed by the issuer. A replacement approval revokes older approved grants to the same recipient.

## Consortium and audit

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/network` | Chain ID, block height, registry address, institutions and outbox counts |
| GET | `/audit` | At most 150 visible events selected from the latest 1,000 global entries |
| POST | `/institutions` | Administrator only; register member wallet and officer account |

Onboarding payload:

```json
{ "name": "Research Credit Union", "code": "RCU", "email": "officer@research.example" }
```

Returns `{ id, email, temporaryPassword }`. Codes and emails must be unique. The development chain supplies 19 institution accounts plus one administrator account. The three seeded institutions use the first three member slots.

The audit endpoint is a bounded demonstration feed, not a complete paginated archival interface. CSV export covers the currently visible feed. UI metrics are descriptive counts; they are not performance or cost-savings benchmarks.
