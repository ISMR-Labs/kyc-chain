# KYC Chain

**Blockchain-Based Cross-Institutional KYC Deduplication and Versioning Framework for Identity Verification**

A runnable BIS final-year project prototype. Institution officers register and verify identities, other institutions discover existing records without receiving their personal details, and customers authorize version-specific sharing. Each identity change, consent attestation and verification reuse executes a Solidity transaction on a persistent local Ethereum chain.

## Run it

Requires **Node.js 22.13 or newer** and npm. Tested on macOS with Node.js 23.11.0. No wallet extension, public-chain account, API key, paid service or separate database is required.

```sh
npm ci
SEED_DEMO=true DATA_DIR=./data-training PORT=4311 npm start
```

From the repository root, run the commands above and open **http://127.0.0.1:4311**. Keep this training dataset separate from your normal workspace.

The first start compiles and deploys the contract, creates institution accounts and seeds synthetic examples. Later starts reuse the same vault and blockchain. Internet access is needed to install packages, but not to run the installed application.

The server binds to `127.0.0.1` by default. `PORT` changes the port; `DATA_DIR` selects a separate persistent dataset. Keep the default loopback binding for the demo.

```sh
SEED_DEMO=true PORT=4312 DATA_DIR=./data-second-demo npm start
```

Stop with `Ctrl+C`. Only one process can open a given data directory at a time.

## Demo accounts

All five accounts below use **`Demo@12345`**. Use the blank sign-in form. Open Account settings and sign out before changing training roles.

| Role | Email | Demonstrates |
| --- | --- | --- |
| Ceylon Trust Bank officer | `officer@ceylon.demo` | Register, verify, update and revoke identities |
| Serendib Finance officer | `officer@serendib.demo` | Discover a duplicate, request consent, reuse verification |
| Lanka Digital Bank officer | `officer@lanka.demo` | A third independent institution account |
| Customer: Asha Senanayake | `customer@kyc.demo` | Approve, reject and revoke sharing |
| Consortium administrator | `admin@kyc.demo` | View network metadata and onboard institutions |

All people and institutions are fictional. Demo identities use synthetic document numbers. **Do not enter real KYC information.**

New registrations create a customer portal account when the supplied portal email is new. The generated password is displayed once. New institution onboarding works the same way. This prototype does not send email; operator password recovery is documented in [Deployment](DEPLOYMENT.md). Other seeded customers have generated passwords; use Asha for the customer demo.

## Included functionality

- Responsive dashboard with institution, customer and administrator roles.
- Exact cross-institution document deduplication using normalized country, document type and number, indexed with HMAC-SHA-256.
- AES-256-GCM encrypted KYC snapshots and optional PDF/PNG/JPEG evidence, up to 2 MB per upload.
- Immutable identity versions: submission → verification → update → re-verification, with optional final revocation.
- A diff view that highlights field changes against the preceding accessible version.
- Salted version commitments, previous-version links, transaction hashes and block numbers.
- Version-specific customer consent with purpose, expiry, rejection and revocation.
- Contract-enforced issuer ownership, member authorization, latest-version checks and consent checks for reuse.
- Integrity verification against the encrypted snapshot, contract state and transaction receipt.
- Audit trail, CSV export, network explorer and separate Help Center.
- Durable transaction outbox to reconcile a confirmed blockchain write after an interrupted database commit.
- Persistent SQLite and EVM data, synthetic seeding, automated API/contract/browser tests.

## Five-minute demonstration

1. Sign in as **Ceylon Trust Bank**. Open **Asha Senanayake**. Four seeded versions show submission, verification, address update and re-verification.
2. Select version 3 to see the address change. Run **Integrity verification**; all four accessible versions should match the blockchain.
3. Switch to **Serendib Finance**. Open **Deduplication** and search country **Sri Lanka**, type **National Identity Card**, number **`199512345678`**. The match reveals the issuer and status, not Asha’s personal details.
4. A pending request from Serendib is already seeded. Switch to **Customer portal**, open **Consent requests**, and approve it for 7, 30 or 90 days.
5. Switch back to Serendib. Asha now appears in the registry. Open the record and select **Reuse verification**. Inspect its confirmed transaction.
6. As Ceylon, create a new address version. It becomes pending. Serendib may still read the previously approved snapshot, but cannot reuse it as the latest verification.
7. Verify the new version as Ceylon, request fresh consent as Serendib, and approve it as the customer. The old grant is replaced.
8. Revoke consent as the customer. Serendib immediately loses future access through the application.
9. Show **Blockchain explorer**, **Audit trail**, and **Help Center** during the presentation.

The flow changes the current demo dataset. To start a separate clean demonstration without deleting anything, select a new `DATA_DIR` as shown above.

## Validation

```sh
npm run check         # JavaScript syntax
npm run compile       # Compile Solidity; writes artifacts/KYCRegistry.json
npm run test:api      # API, cryptography, contract and recovery checks
npm run test:browser  # Real browser workflow and responsive checks
npm test             # Both suites
```

The browser test uses installed Google Chrome on macOS. On other systems, install the matching browser once with `npx playwright install chromium`, or set `BROWSER_PATH` to a Chromium executable.

The automated suite covers browser workflows, API/contract authorization, cryptography, recovery and deployment safeguards. Tests use isolated temporary vaults and chains; they do not mutate the demonstration dataset. Screenshots are written to `artifacts/screenshots/`.

## Project structure

```text
contracts/KYCRegistry.sol    Permissioned registry and consent/reuse contract
server/index.js             HTTP API, authentication, sessions, CSRF and static UI
server/service.js           KYC workflows, authorization, versioning and synthetic seed
server/crypto.js            Canonical hashes, keyed fingerprints, encryption, passwords
server/chain.js             Persistent local EVM, compilation, signing and outbox recovery
server/store.js             SQLite schema and local key initialization
public/                    Buildless browser UI
tests/                     Real API/contract and browser integration tests
scripts/compile.js          Solidity artifact generation
docs/ARCHITECTURE.md        Data model, flows, invariants and trust boundaries
docs/API.md                 Endpoint and request documentation
docs/FYP-NOTES.md           Business problem, research framing, evaluation and viva notes
data/                      Generated private runtime state; excluded from version control
```

## Prototype boundaries

This is a **real local EVM integration, not a distributed production consortium**. Ganache runs a single node. The server holds all institution keys and relays consent using the issuer’s key after authenticating the customer. Verification is a manual officer attestation, not a government database, OCR, biometric or document-forensics check. Exact matching cannot connect different documents belonging to the same person.

Only identity snapshots and evidence are encrypted as described; account names/emails, operational metadata, reasons and audit events are stored off-chain in ordinary database columns. Do not put unnecessary personal data in reasons or consent purposes. Ledger participants can observe pseudonymous identifiers, version activity and institutional relationships. The server and local filesystem administrator are trusted in this prototype.

Read audit events are off-chain and are not claimed to be immutable. Revocation prevents future application access, not retention of copies already received. Password changes and operator-assisted recovery are implemented. MFA, key rotation, institutional key custody, customer signatures, independent validators and compliance certification are not implemented.

The complete `data/` directory is one recovery unit: encryption keys, SQLite files and chain storage must stay together. Stop the server before backing it up. Never commit or share `data/keys.json`, runtime databases, or institution signing material. Use an isolated `DATA_DIR` for demos instead of removing data.

Ganache may print a µWS compatibility warning with newer Node.js versions and fall back to its JavaScript implementation. This was observed on Node.js 23.11.0; the app and tests passed using that fallback. Node may also label its built-in SQLite module experimental.

## Technical references

- [ethers v6 documentation](https://docs.ethers.org/v6/single-page/)
- [Node.js SQLite API](https://nodejs.org/download/release/v23.3.0/docs/api/sqlite.html)
- [Solidity contracts documentation](https://docs.soliditylang.org/en/latest/contracts.html)

These references inform implementation. The project does not claim legal compliance, measured cost savings, or production-grade identity assurance.
