# Deployment and recovery

## Topology

```text
Browser → HTTPS kyc.dilanp.duckdns.org → existing Nginx Proxy Manager
                                         ↓ private Docker proxy network
                                      kyc-chain
                                         ↓ internal Docker ledger network
                                      kyc-ledger (Besu QBFT)
```

No new host HTTP, RPC or peer ports are published. The proxy uses the existing wildcard certificate and a separately included `kyc-chain.conf`. It does not replace other applications' virtual hosts. The app trusts only the verified proxy IP (`172.21.0.2`); if that address changes, update `TRUST_PROXY` before recreating the app.

The application runs as UID 1000 with a read-only root filesystem, a bounded temporary filesystem, dropped Linux capabilities, no-new-privileges, resource limits, rotated container logs and automatic restart. The ledger has separate private storage and an internal-only network. Runtime dependencies are installed from `deploy/package-lock.json`; contract compilation uses `deploy/compiler/package-lock.json`.

## Files on the server

```text
/home/dilan/apps/kyc-chain/
  releases/20261017-1/    source and Docker Compose configuration
  deployment.env         origin, private data paths, release and trusted proxy
  shared/data/           encryption keys, vault, sessions, outbox, bootstrap credentials
  shared/ledger/         genesis, validator key and chain storage
  backups/               consistent stopped-service archives
```

The SSH key already authorized for the server is used for deployment. SSH passwords are not written into the application or repository.

## Operations

```sh
docker ps --filter name=kyc
docker logs --tail 100 kyc-chain
docker logs --tail 100 kyc-ledger
curl --fail https://kyc.dilanp.duckdns.org/api/health
```

Health returns 503 if the ledger is unavailable or transaction recovery is pending. Startup recovers prepared outbox transactions before accepting traffic. A confirmed transaction followed by an interrupted database commit should be reconciled by restarting the app; do not reset chain storage or edit version rows to resolve it.

To recreate services using the selected release:

```sh
docker compose --env-file /home/dilan/apps/kyc-chain/deployment.env \
  -f /home/dilan/apps/kyc-chain/releases/20261017-1/deploy/compose.yml up -d --no-build
```

The web app image contains neither Ganache nor the Solidity compiler. Ganache remains a development/test dependency in the repository, with advisories; do not deploy the training dependency tree as the web service.

## Administrator access

The generated administrator email is `admin@kyc.dilanp.duckdns.org`. Read the protected `shared/data/bootstrap-admin.txt` file on the server for its initial password. The UI requires replacement at first sign-in. Do not put that password in source control or proxy configuration.

After signing in, onboard institutions under Blockchain explorer. Every new officer/customer account starts with a generated temporary password that must be replaced. Securely deliver those credentials to the intended person. No SMTP service or automatic identity verification is configured.

## Backup

Run the release's `deploy/backup.sh` as the deployment user. It records which services were running, stops the app before the ledger, archives both private directories, verifies the archive and restores the prior running state. The stop is necessary for a consistent vault/chain recovery point and causes a short maintenance interruption. A user crontab entry runs this at 03:15 server time, preserving existing entries.

Archives include sensitive keys and records, have restricted permissions, and stay under `backups/`. An on-server backup protects against a bad deployment; it does not protect against loss of the server. Add encrypted off-site backups before relying on the system for important data. No automatic deletion is performed; monitor disk usage and define a retention policy.

## Restore

1. Stop `kyc-chain` and `kyc-ledger`.
2. Preserve the current `shared/data` and `shared/ledger` directories under timestamped names; do not overwrite them in place.
3. Extract a complete backup's `data` and `ledger` directories into `shared/`, retaining ownership and private permissions.
4. Start the ledger, then the application.
5. Check health, administrator access, registry address, latest versions and integrity before reopening use.

Never restore only SQLite, only keys or only ledger data. They are one recovery unit. Restoring an older complete backup can also restore older credentials/sessions; invalidate sessions and reset affected credentials as part of incident recovery.

## Operator password recovery

Stop the application, then run its recovery script with the same data mount. The script writes a temporary password to a protected file and revokes the account's sessions. It does not print the password in container logs.

```sh
docker stop kyc-chain
docker run --rm --user 1000:1000 \
  -e DATA_DIR=/var/lib/kyc-chain \
  -v /home/dilan/apps/kyc-chain/shared/data:/var/lib/kyc-chain \
  kyc-chain:20261017-1 node scripts/reset-password.js account@example.com
docker start kyc-chain
```

Read the newly generated `password-reset-*.txt` file privately and deliver the temporary credential securely. First sign-in requires another change.

## Scope of production readiness

The host configuration, application authentication and deployment controls are hardened, but the overall KYC service remains a pilot. The deployed ledger has one validator under the same operator as the app; institutions do not hold independent keys and customers do not independently sign chain transactions. The app uses manual verification attestations. These are explicit architectural limits, not features provided by hosting over HTTPS.

Before regulated use: establish independent validator/key governance, integrate reviewed identity proofing, assess data retention and consent requirements, perform security/contract reviews, establish monitoring and off-site recovery, and validate the operational model with the relevant institution. The server's other services are outside this application's security boundary.

Technical references: [Besu QBFT configuration](https://github.com/besu-eth/besu-docs/blob/main/docs/private-networks/tutorials/qbft.md), [Besu free-gas configuration](https://docs.besu-eth.org/private-networks/how-to/configure/free-gas/), and [Express reverse-proxy configuration](https://expressjs.com/en/guide/behind-proxies/).

## Verification of this deployment

The release passed 21 automated checks before deployment. A separate contract on the hosted Besu ledger passed deployment, membership, version, consent and reuse tests, including unauthorized-write and stale-reuse rejection, without changing the live registry. Real Chrome verified trusted HTTPS, secure session cookies, the mandatory initial password change, rejection of the old demo administrator, the separate Help Center and mobile layout.

The Besu container needs an executable private `/tmp` mount to load its native Java libraries. Its root filesystem remains read-only and its ledger network is internal.
