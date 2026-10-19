#!/usr/bin/env bash
set -euo pipefail
umask 077
task_root="${KYC_DEPLOY_ROOT:-/home/dilan/apps/kyc-chain}"
mkdir -p "$task_root/backups"
exec 9>"$task_root/backups/backup.lock"
flock -n 9 || exit 0
archive="$task_root/backups/kyc-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
was_running="$(docker inspect -f '{{.State.Running}}' kyc-chain)"
ledger_was_running="$(docker inspect -f '{{.State.Running}}' kyc-ledger)"
restore_services() {
  if [ "$ledger_was_running" = true ]; then docker start kyc-ledger >/dev/null; fi
  if [ "$was_running" = true ]; then docker start kyc-chain >/dev/null; fi
}
trap restore_services EXIT
if [ "$was_running" = true ]; then
  docker stop --time 45 kyc-chain >/dev/null
fi
if [ "$ledger_was_running" = true ]; then docker stop --time 60 kyc-ledger >/dev/null; fi
tar -czf "$archive" -C "$task_root/shared" data ledger
tar -tzf "$archive" >/dev/null
restore_services
trap - EXIT
printf 'Backup completed: %s\n' "$archive"
# No automatic deletion. Retention is an operator decision.
