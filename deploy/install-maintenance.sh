#!/usr/bin/env bash
set -euo pipefail
task_root=/home/dilan/apps/kyc-chain
checkout="$task_root/releases/20261017-1"
python3 - <<'PY'
import subprocess
line = '15 3 * * * /bin/bash /home/dilan/apps/kyc-chain/releases/20261017-1/deploy/backup.sh >> /home/dilan/apps/kyc-chain/backups/cron.log 2>&1 # kyc-chain-backup'
existing = subprocess.run(['crontab', '-l'], text=True, capture_output=True)
if existing.returncode not in (0, 1):
    raise RuntimeError('Unable to inspect existing crontab')
lines = existing.stdout.splitlines()
if not any('# kyc-chain-backup' in entry for entry in lines):
    subprocess.run(['crontab', '-'], input='\n'.join(lines+[line])+'\n', text=True, check=True)
    print('Daily KYC backup scheduled for 03:15 server time. Existing cron entries preserved.')
else:
    print('KYC backup schedule already exists.')
PY
bash "$checkout/deploy/backup.sh"
