# Deploying to Hetzner

Runbook for a single Hetzner box running the API, the tip follower, and the
periodic syncs. One machine is enough: the index is a SQLite file and the
workload is a handful of RPC reads per request.

## Sizing

A **CX22** (2 vCPU, 4 GB, 40 GB) is comfortable. The constraint is disk and
the disk is small:

| | |
|---|---|
| `data/oracle.db` after a genesis backfill | ~350 MB (996k pools across both protocols) |
| Growth | ~19k v4 pools/day observed, so budget ~10 GB/year |
| Peak RAM | the volume pass holds a per-pool accumulator in memory, ~300 MB |

The genesis backfill is CPU-light and network-bound. It is the periodic volume
sync — an hour of walking swap logs — that decides the sizing, not the API.

## Prepare the server

```bash
adduser --system --group --home /opt/rh-oracle oracle
apt update && apt install -y curl git rsync

# Node 22+ is required (node:sqlite, --env-file-if-exists).
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs

# Caddy, for TLS.
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

mkdir -p /opt/rh-oracle/data && chown -R oracle:oracle /opt/rh-oracle
```

Firewall: **80 and 443 only**. The API binds `127.0.0.1:8080` (`HOST` in the
unit file), so Caddy is the only route in.

```bash
ufw default deny incoming && ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
```

## Credentials

`.env` lives **only on the server** and is never shipped by the deploy script,
which also excludes `data/` from both the transfer and its `--delete`. A deploy
cannot destroy the index or the credentials.

```bash
sudo -u oracle cp /opt/rh-oracle/.env.example /opt/rh-oracle/.env
sudo -u oracle nano /opt/rh-oracle/.env
sudo chmod 600 /opt/rh-oracle/.env
```

Set at minimum:

```
HOST=127.0.0.1
DB_PATH=/opt/rh-oracle/data/oracle.db
ALCHEMY_API_KEY=...            # state and archive reads
# RH_LOGS_RPC_URL stays the public endpoint: it takes 200k-block ranges,
# where Alchemy's free tier caps eth_getLogs at 10 blocks. See the README.
```

Farcaster credentials are only needed to *publish*. Leave them empty and the
agent still scans, drafts and queues — it simply cannot send.

## First run

```bash
./ops/deploy.sh oracle@<server-ip>

# then, on the server, seed the index once (about 20 minutes total)
sudo -u oracle -i
cd /opt/rh-oracle
npm run registry:sync
npm run index:backfill          # v4 from block 9,070  — ~4 min
npm run index:backfill:v3       # v3 from block 8,930  — ~13 min
npm run corporate:sync
npm run volume:sync             # ~1 h, and only needed before publishing volume claims
```

Both backfills commit their cursor after every range, so an interrupted run
resumes where it stopped — just run it again. Run them under `tmux` or
`systemd-run --scope` so an SSH drop does not kill them.

Point `ops/Caddyfile` at your hostname, then:

```bash
sudo cp /opt/rh-oracle/ops/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## What runs

| Unit | Kind | Does |
|---|---|---|
| `rh-oracle-api` | always on | serves `/quote`, `/prepare-swap`, `/gas`, `/corporate-actions`, `/coverage`, `/ask` |
| `rh-oracle-watch` | always on | follows the tip for new v4 **and** v3 pools, 5 blocks behind |
| `rh-oracle-sync.timer` | every 6h | registry, corporate calendar, holders, 24h volume |
| `rh-oracle-agent.timer` | daily 07:30 | scans for signals and queues **drafts** |

**Nothing on this box can publish.** The agent timer only writes to the
approval queue; sending needs a person to approve a draft and then run
`npm run agent:publish -- --live` by hand. That is deliberate, and it is why
the timer is safe to leave enabled.

## Operating

```bash
systemctl status rh-oracle-api rh-oracle-watch
journalctl -u rh-oracle-watch -f
systemctl list-timers 'rh-oracle-*'
curl -s localhost:8080/health | jq
```

`/health` reports both protocols and the indexer cursors. A cursor that stops
advancing is the failure to watch for: the API keeps answering happily from a
stale index, so the endpoint looking healthy proves nothing about freshness.

Review and publish (from anywhere with the DB, normally on the server):

```bash
npm run agent:queue
npm run agent:approve -- <id>
npm run agent:publish                # dry run
npm run agent:publish -- --live      # actually sends
```

## Backups

The database is a cache — every row is reconstructible from the chain and the
two public registries — so losing it costs the ~20 minutes of backfill above,
not data. Worth snapshotting anyway, because the approval queue is *not*
reconstructible: `posts` and `signals` hold decisions a person made.

```bash
sudo -u oracle sqlite3 /opt/rh-oracle/data/oracle.db \
  ".backup '/opt/rh-oracle/data/backup-$(date +%F).db'"
```

Use `.backup` rather than copying the file: the database runs in WAL mode and
a plain `cp` of a live WAL database can produce a torn copy.
