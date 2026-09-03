#!/usr/bin/env bash
# Deploy to the Hetzner box. Idempotent; safe to re-run.
#
#   ./ops/deploy.sh oracle@203.0.113.10
#
# Ships the source, installs dependencies, reloads systemd. It never touches
# .env or data/ -- credentials and the index live only on the server.
set -euo pipefail

TARGET="${1:?usage: deploy.sh user@host}"
REMOTE_DIR="${REMOTE_DIR:-/opt/rh-oracle}"

echo "==> syncing source to ${TARGET}:${REMOTE_DIR}"
# --delete keeps the remote clean, but data/ and .env are excluded from both
# the transfer and the delete, so a deploy can never destroy the index or the
# credentials.
rsync -az --delete \
	--exclude '.git' \
	--exclude 'node_modules' \
	--exclude 'data' \
	--exclude '.env' \
	--exclude '*.log' \
	./ "${TARGET}:${REMOTE_DIR}/"

echo "==> installing dependencies"
# tsx is a runtime dependency here, not a build tool: every service runs
# `node --import tsx`. It lives in "dependencies" for that reason, so
# --omit=dev is safe -- but only because of that.
ssh "${TARGET}" "cd ${REMOTE_DIR} && npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund"

echo "==> checking .env exists on the server"
ssh "${TARGET}" "test -f ${REMOTE_DIR}/.env" || {
	echo "ERROR: ${REMOTE_DIR}/.env is missing on the server." >&2
	echo "Create it there from .env.example. Secrets are never shipped from here." >&2
	exit 1
}

echo "==> installing systemd units"
ssh "${TARGET}" "sudo cp ${REMOTE_DIR}/ops/systemd/*.service ${REMOTE_DIR}/ops/systemd/*.timer /etc/systemd/system/ && sudo systemctl daemon-reload"

echo "==> restarting services"
ssh "${TARGET}" "sudo systemctl restart rh-oracle-api rh-oracle-watch && sudo systemctl enable --now rh-oracle-sync.timer rh-oracle-agent.timer rh-oracle-sample.timer"

echo "==> health"
ssh "${TARGET}" "sleep 3 && curl -fsS localhost:8080/health" && echo
echo "done"
