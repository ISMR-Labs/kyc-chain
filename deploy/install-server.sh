#!/usr/bin/env bash
# Install a new isolated release on the authorized home server. No existing app is replaced.
set -euo pipefail
umask 077
release="${1:?Usage: install-server.sh release-id}"
[[ "$release" =~ ^[0-9]{8}-[0-9]+$ ]] || { echo 'Invalid release ID'; exit 1; }
task_root=/home/dilan/apps/kyc-chain
checkout="$task_root/releases/$release"
mkdir -p "$task_root/shared/data" "$task_root/shared/ledger/config" "$task_root/shared/ledger/data" "$task_root/backups"
chmod 700 "$task_root/shared" "$task_root/shared/data" "$task_root/shared/ledger" "$task_root/backups"
docker build -t "kyc-chain:$release" -f "$checkout/Dockerfile" "$checkout"
if [ ! -f "$task_root/shared/ledger/config/genesis.json" ]; then
  if [ ! -f "$task_root/shared/ledger/qbft.json" ]; then
    docker run --rm --user 1000:1000 -e DATA_DIR=/var/lib/kyc-chain -v "$task_root/shared/data:/var/lib/kyc-chain" -v "$task_root/shared/ledger:/bootstrap" "kyc-chain:$release" node scripts/prepare-ledger.js /bootstrap/qbft.json
  fi
  if [ ! -f "$task_root/shared/ledger/generated/genesis.json" ]; then
    docker run --rm --user 1000:1000 --memory 1g -e JAVA_OPTS=-Xmx512m -v "$task_root/shared/ledger:/bootstrap" hyperledger/besu:26.9.0 operator generate-blockchain-config --config-file=/bootstrap/qbft.json --to=/bootstrap/generated --private-key-file-name=key
  fi
  python3 - "$task_root/shared/ledger" <<'PY'
import sys, shutil
from pathlib import Path
root = Path(sys.argv[1])
keys = list((root/'generated'/'keys').glob('*/key'))
assert len(keys) == 1, 'Expected exactly one configured validator'
shutil.copyfile(root/'generated'/'genesis.json', root/'config'/'genesis.json')
shutil.copyfile(keys[0], root/'config'/'key')
(root/'config'/'key').chmod(0o600)
PY
fi
cat > "$task_root/deployment.env" <<EOF
KYC_RELEASE=$release
PUBLIC_ORIGIN=https://kyc.dilanp.duckdns.org
TRUST_PROXY=172.21.0.2
ADMIN_EMAIL=admin@kyc.dilanp.duckdns.org
KYC_DATA_DIR=$task_root/shared/data
KYC_LEDGER_DIR=$task_root/shared/ledger
PROXY_NETWORK=nginx-proxy-manager_default
EOF
docker compose --env-file "$task_root/deployment.env" -f "$checkout/deploy/compose.yml" up -d --no-build
printf 'Release %s started. Confirm health before adding the HTTPS proxy route.\n' "$release"
