# BIS final-year project notes

These notes describe the implemented artifact and suggest an evaluation plan. They are a starting point for the student's own report, literature review, research methods, supervisor feedback and findings. They do not fabricate surveys, interviews, experiments, citations or financial savings.

## Problem and business context

Separate institutions may collect and review substantially similar customer identity information. Without a shared reference, each institution can repeat onboarding work while maintaining a different version of the same customer's details. Reusing an old verification without knowing its version, origin or consent status can create operational uncertainty.

This prototype investigates whether a permissioned shared registry can support discovery and controlled reuse while keeping full KYC profiles off-chain. The business processes are customer onboarding, verification review, consent handling, data updates and audit investigation.

## Aim

Design, implement and evaluate a prototype that prevents duplicate registration of the same identity document, preserves a verifiable identity version history, and supports customer-authorized cross-institution verification reuse.

## Objectives mapped to the artifact

| Objective | Implemented feature | Evidence |
| --- | --- | --- |
| Detect repeated document registration | Normalized keyed fingerprint and unique database index | Duplicate and concurrent-registration tests |
| Protect profile storage | AES-GCM snapshots with per-version authenticated context | Encryption and tamper tests |
| Preserve verifiable evolution | Append-only contract versions with previous digest and expected version | Version comparison, stale-write and contract tests |
| Control sharing | Customer portal and version/recipient/expiry-scoped grants | Approval, role-denial and revocation tests |
| Support safe reuse | Latest verified version, consent and integrity checks | Reuse success and stale-reuse rejection |
| Maintain consistency across stores | Prepared signed-transaction outbox and startup reconciliation | Simulated post-mining SQL failure and restart test |
| Demonstrate business usability | Institution, customer and administrator workspaces | Real browser workflow and mobile checks |

## Candidate research questions

1. How effectively does document-based deduplication prevent repeated registration within a shared institutional registry?
2. How can version-bound consent prevent an institution from silently reusing stale verification data?
3. What business and privacy tradeoffs arise when profiles remain off-chain but verification commitments are shared?
4. What consistency mechanisms are needed when a workflow writes to both a blockchain and a conventional database?
5. How do officers and customers understand the proposed verification and consent workflow?

## Functional scope

Actors: institution officer, customer and consortium administrator. Core use cases: register identity, search duplicate, review/verify submission, append corrected version, inspect history, request consent, decide consent, reuse verification, revoke identity, inspect audit and onboard institution.

Excluded: real government verification, document authenticity detection, facial recognition, fuzzy person matching, linking different documents to the same person, sanctions/PEP screening, live bank integrations, production identity federation and legal certification. These exclusions help keep the evaluation aligned with what the implementation actually proves.

## Why a blockchain is present

The implemented contract applies consistent issuer/membership/version rules and exposes verifiable version commitments and reuse events. The database supplies private profile storage and the UI supplies business workflows.

In this local implementation, one backend controls every signing key and one development node executes transactions. Consequently, it does **not** establish distributed trust against that backend. The defensible claim is that the artifact demonstrates the data model, smart-contract rules, provenance checks and integration workflow that a future independently operated consortium could use. A conventional append-only database could cover some of the same needs under centralized governance. Compare these alternatives explicitly in the report.

## Evaluation performed

Automated checks were executed using the real API, a deployed local Solidity contract and a headless Chrome browser. The suite reported **21 passing checks**:

- 1 cryptography test.
- 1 secure deployment integration test.
- 11 backend/API/contract/recovery subtests and their parent integration test.
- 6 browser workflow subtests and their parent integration test.

The tests cover unauthorized access, CSRF, wrong-origin writes, duplicate detection, uniqueness under concurrent requests, customer-only consent, version-scoped visibility, issuer-only writes, stale updates, contract access rules, revoked access, encrypted snapshot tampering, forged receipt references, file access, institution onboarding, final identity revocation, persistence and transaction recovery. Browser checks cover history comparison, integrity results, mobile overflow, private lookup, approval/reuse, registration/update, audit export and explorer/guide rendering.

This is evidence of tested behavior for the covered scenarios. It is not a formal proof, penetration test, smart-contract audit, scalability benchmark or study of real-world users. Screenshots from the browser run are available in `artifacts/screenshots/`.

## Recommended empirical evaluation

Conduct the following only after defining the protocol and receiving whatever approvals your institution requires. Report actual observations; do not substitute sample values for findings.

| Dimension | Suggested measurement | Important control |
| --- | --- | --- |
| Deduplication accuracy | Confusion matrix for same-document cases, formatting variants and near misses | Keep cross-document/person matching separate |
| Workflow efficiency | Steps and completion time for fresh KYC versus consented reuse | Use comparable synthetic tasks and counterbalanced order |
| Version correctness | Stale-reuse rejection rate and detected integrity mutations | State the exact corruption cases introduced |
| Usability | Task completion, errors and interview themes across officer/customer roles | Separate observed evidence from participant opinion |
| Performance | Median and p95 lookup/anchor/reuse latency across dataset sizes | Record machine, node configuration, warm-up and concurrency |
| Recovery | Recovery time and consistency after each simulated crash point | Test before broadcast, after mining and before DB commit separately |
| Alternatives | Centralized append-only ledger versus consortium ledger | Compare governance, cost, trust and privacy assumptions |

Potential hypotheses, if appropriate to the research design: reuse reduces repeated data-entry steps; stale-version checks prevent defined outdated-reuse scenarios; users can distinguish granting access from verifying identity. These remain proposed hypotheses until evaluated.

## Suggested report structure

1. Introduction, problem, stakeholders, scope and research questions.
2. Literature review: KYC reuse, digital identity, permissioned ledgers, off-chain data, versioning and consent.
3. Methodology: artifact development, requirements elicitation, evaluation design and ethics.
4. Requirements and process models: as-is/to-be onboarding, use cases and role matrix.
5. Design: architecture, ER model, state/sequence diagrams, contract, privacy and trust boundaries.
6. Implementation: representative code, UI workflows, encryption and transaction recovery.
7. Evaluation: actual tests, measured results, participant evidence where collected, limitations.
8. Discussion and conclusion: business implications, tradeoffs, governance and future work.

Architecture diagrams and the schema explanation are in `ARCHITECTURE.md`. Request/response details are in `API.md`.

## Viva preparation

**What exactly is deduplicated?** The same normalized document number within an issuing-country/document-type namespace. The prototype does not infer that two different documents identify the same person.

**What is on-chain?** Pseudonymous references, issuer/member addresses, version commitments and links, status, consent metadata, timestamps and events. Full profiles and evidence remain off-chain.

**Does a hash verify a customer's identity?** No. It lets us compare a current snapshot with the originally committed snapshot. An officer performs the verification attestation.

**Why add a random nonce to the version commitment?** It makes straightforward guessing of low-entropy profile contents harder. The separate HMAC index supports deterministic exact matching without publishing a plain document hash.

**Why create a new version when verifying?** Verification changes the record's state. Recording it as a separate version preserves the pending submission and the later attestation.

**What happens after an update?** The new version is pending. Existing consent remains bound to the previously approved snapshot. New reuse requires verification and fresh consent for the new version.

**Can the customer revoke access?** Yes, future reads and reuse through the application are blocked. Copies already downloaded cannot be recalled.

**What if the blockchain succeeds and the database fails?** The signed transaction and database mutations were saved in the outbox before broadcast. Startup recovery verifies the receipt and commits the pending mutations. The test suite simulates this failure.

**Who signs customer consent?** The application authenticates the customer; the issuer's server-controlled account relays an attestation. Independent customer signatures are future work.

**Is the chain decentralized?** No. It is a persistent single-node local EVM. Independent institutional validators and key custody would be necessary to evaluate distributed trust.

**Does it comply with financial/privacy regulations?** No compliance claim is made. Real deployment needs jurisdiction-specific requirements, review and operational governance beyond this research prototype.

## Future work

Prioritize institutional key custody and independently signed consent, then an independently operated permissioned validator network. Further work includes matching-policy governance, approved real identity-proofing integrations, retention/deletion workflows, key rotation, encrypted access-grant key distribution, two-person review, paginated archival audit, revocation notifications, accessibility testing with participants and realistic load evaluation.
