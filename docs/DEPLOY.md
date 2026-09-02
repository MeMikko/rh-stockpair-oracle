# Deploying to Hetzner

Runbook for a Hetzner box running the API, the tip follower, and the periodic
syncs. One machine is enough: the index is a SQLite file and the workload is a
handful of RPC reads per request.

## If the box already runs something else

**Read this first.** Three steps below can take down an existing tenant, and
two of them do it silently:

| Step | Risk |
|---|---|
| `apt install nodejs` from NodeSource | **replaces the system Node**, breaking anything built against the old major |
| copying a whole `/etc/caddy/Caddyfile` | **removes every other site** the server was serving |
| `ufw enable` | **drops every port not explicitly allowed**, including the other project's |

So survey first. It changes nothing:

```bash
bash ops/preflight.sh
```

Resolve every `CONFLICT` before deploying. In particular this project now
ships `ops/rh-oracle.caddy` as a **site snippet, not a Caddyfile** — install it
alongside the existing config and reload rather than restart:

```bash
sudo mkdir -p /etc/caddy/conf.d
sudo cp /opt/rh-oracle/ops/rh-oracle.caddy /etc/caddy/conf.d/
# main Caddyfile needs this once, at top level, outside any site block:
#   import /etc/caddy/conf.d/*.caddy
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The services also carry `MemoryMax`, `CPUWeight` and `Nice` so they yield to
the other tenant — the hourly volume sync runs for an hour at sustained
network load and is set to lose every contest for CPU and IO.

If you already own a domain for the other project, a subdomain of it
(`oracle.yourdomain.tld`) is the right hostname here: one DNS A record, a real
certificate, and a stable URL for the skill catalogue.

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
# Node 22+ is required. If the box already has an older Node that another
# project depends on, do NOT install from NodeSource — it replaces the system
# binary. Install 22 for the oracle user instead and point ExecStart at it:
#   curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22
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

On a **fresh** box:

```bash
ufw default deny incoming && ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
```

On a box that already serves something, do **not** run the above — it will cut
off whatever ports that project uses. If ufw is already active, 80 and 443 are
almost certainly open already; verify with `ufw status numbered` and add only
what is missing.

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

## Installing

Two ways in. **Cloning on the server is the simpler one** and needs no SSH
access from your workstation at all — the repository is public, so the server
pulls it directly. Use this if you administer the box from a console.

```bash
# on the server, as root
apt update && apt install -y git

# clone straight to the target path; without one, git would create
# ./rh-stockpair-oracle in whatever directory you happen to be in
git clone https://github.com/MeMikko/rh-stockpair-oracle /opt/rh-oracle
cd /opt/rh-oracle

# survey before changing anything on a box that already serves something
bash ops/preflight.sh
```

Ownership matters from here on. Once the tree belongs to `oracle`, run git as
that user:

```bash
sudo -u oracle git -C /opt/rh-oracle pull
sudo systemctl restart rh-oracle-api rh-oracle-watch
```

Pulling as root works only after silencing git's `dubious ownership` check, and
then leaves root-owned files in a tree the `oracle` user has to write to — the
next `sudo -u oracle npm ci` fails on them. `.env` and `data/` are gitignored,
so a pull can never overwrite the credentials or the index.

The alternative pushes from a workstation that has SSH access:

```bash
./ops/deploy.sh oracle@<server-ip>
```

## First run

```bash

# on the server, seed the index once (about 20 minutes total)
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

### When the reverse proxy is a Caddy container

Common, and it changes two things. Detect it with `ops/preflight.sh`, which
reports who actually owns 80/443.

**The config file.** A caddy container typically bind-mounts a *single*
Caddyfile, so a new file dropped on the host is invisible inside it and the
`conf.d` snippet approach does not apply. Adding a mount means recreating the
container, which takes the existing site down. Append to the mounted file
instead and reload:

```bash
CF=/opt/<project>/deploy/Caddyfile          # from `docker inspect ... .Mounts`
cp "$CF" "$CF.bak-$(date +%F)"
cat /opt/rh-oracle/ops/rh-oracle-docker-caddy.snippet >> "$CF"
docker exec <caddy-container> caddy validate --config /etc/caddy/Caddyfile
docker exec <caddy-container> caddy reload  --config /etc/caddy/Caddyfile
```

`reload` is graceful — the existing site serves throughout. Never `restart`.

**The upstream address.** `127.0.0.1:8080` inside a container is the container
itself, not the host, so the usual loopback binding is unreachable. Use the
gateway of the container's own Docker network:

```bash
docker inspect <caddy-container>   --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}'   # e.g. 172.18.0.1
```

Set `HOST` to that address in `/opt/rh-oracle/.env` and point `reverse_proxy`
at it. That address is reachable from containers and the host and is never
routable from the internet, so the origin stays closed even if a firewall rule
is later changed by mistake — which `HOST=0.0.0.0` plus a ufw rule would not
survive.

### Behind Cloudflare

A proxied A record (orange cloud) means Cloudflare terminates TLS at its edge,
and three things follow.

**The certificate.** Caddy cannot complete an HTTP-01 challenge through the
proxy. Use a **Cloudflare Origin Certificate** (free, 15 years) with the zone
set to **Full (strict)**, or leave the record DNS-only and let Caddy get a
normal Let's Encrypt certificate. Never use **Flexible** SSL — it fetches the
origin over plain HTTP, so swap calldata crosses the last hop unencrypted.

**The caller's address.** Behind a proxy `req.ip` is Cloudflare's edge, not the
caller's, so every caller collapses into a handful of IPs and the per-caller
usage counts — the one number a pricing decision needs — become meaningless.
Set:

```
TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip
```

The header is only honoured when that variable is set, because a forwarded
header is caller-controlled: trusting one by default would let anyone who
reaches the origin directly forge their identity. Pair it with the Cloudflare
IP allowlist in `ops/rh-oracle.caddy`.

**Caching.** Responses now carry explicit `Cache-Control`: `no-store`
everywhere except `/coverage`. A cached `/quote` is a stale price presented as
a live one, and a cached `/prepare-swap` is calldata whose min-out was derived
from a market that has since moved. Do not add a Cloudflare cache rule that
overrides this.

One adoption caveat: Cloudflare's bot protection can challenge non-browser
clients, and this service exists to be called by other agents. If Bot Fight
Mode or a managed challenge is on for the zone, exempt the oracle hostname —
otherwise the skill will look broken to exactly its intended audience.

### If there is no domain yet

Caddy needs a DNS name to get a certificate; a bare IP cannot have one. To
bring the stack up before a domain exists, use an `sslip.io` hostname — it
resolves to the IP encoded in it and Let's Encrypt will issue for it:

```
203-0-113-10.sslip.io {     # your server's IP, dots replaced by dashes
```

Good enough to test the whole path over real TLS. **Not** good enough to
publish: the hostname contains the IP, so the URL breaks if the box moves, and
the skill catalogue would have to be corrected by another PR. Buy a name before
submitting the skill.

Point `ops/rh-oracle.caddy` at your hostname, then install it as a snippet
alongside any existing sites (see the co-tenancy section above):

```bash
sudo mkdir -p /etc/caddy/conf.d
sudo cp /opt/rh-oracle/ops/rh-oracle.caddy /etc/caddy/conf.d/
sudo caddy validate --config /etc/caddy/Caddyfile
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
