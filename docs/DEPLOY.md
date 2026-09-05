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

### Two Bankr keys, two files

A Bankr API key carries independent capability flags, and one key can hold all
of them: LLM gateway, wallet, agent, token launch. The API process phrases
answers through the gateway, attaching its key to a request whose body contains
text a stranger wrote — so the key it holds must not be able to sign.

So there are two keys in two files, and **no variable appears in both**:

| File | Read by | Holds |
|---|---|---|
| `.env` | every unit | `BANKR_LLM_KEY` — LLM Gateway enabled, wallet/agent/token-launch **off** |
| `.env.admin` | the operator panel only | `BANKR_API_KEY`, `ADMIN_AUTH_SECRET`, `ADMIN_ADDRESSES` |

```bash
sudo -u oracle nano /opt/rh-oracle/.env.admin
sudo chmod 600 /opt/rh-oracle/.env.admin
```

`rh-oracle-api` refuses to start if `BANKR_API_KEY` is in its environment, so a
mistake here fails loudly at boot rather than quietly at 3am. Confirm the split
is real rather than assumed — the flags live in someone else's dashboard:

```bash
sudo -u oracle npm run bankr:scope     # asks Bankr what each key can do
```

### Turning payment on

`PRICING_MODE=paid` is what starts charging. Two things must be right first,
and they are different doors:

- **Bankr's gateway** (`x402.bankr.bot/<wallet>/vates`) collects the payment
  and forwards the request here. Set `VATES_BACKEND_SECRET` to the same value
  on both sides: without it this origin cannot tell a forwarded request from
  anyone setting the same headers, so gateway callers get a 402 they cannot
  fix. `X402_GATEWAY_URL` is advertised to callers and never called by us.
- **Direct `exact`** needs `X402_FACILITATOR_URL` pointed at a *standard* open
  facilitator (`https://x402.org/facilitator`). Never at Bankr — it publishes
  no `/verify` or `/settle` for other people's servers.

The same principle as `bankr:scope`: the configuration is a belief until
something asks.

```bash
sudo -u oracle npm run x402:check      # what the facilitator actually supports
```

It reports both doors: whether the gateway secret is set, and what the
facilitator will settle. A green facilitator means a standard client
(`x402-fetch`) can pay per call; a red one means every priced call would answer
402 with an error about signatures, which reads to the caller as their problem
rather than ours.

`VATES_BACKEND_SECRET` is a shared secret that lets a request skip per-call
payment, so it belongs in `.env` with `chmod 600` and nowhere else. The gateway
hop itself can only be confirmed with a live call — see `x402/README.md`.

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
at it. That address is not routable from the internet, so the origin stays
closed even if a firewall rule is later changed by mistake — which
`HOST=0.0.0.0` plus a ufw rule would not survive.

**An active ufw still blocks the container.** `default deny incoming` applies
to the Docker bridge as well, so traffic from the proxy container to the host
is dropped and Caddy reports `dial tcp <gateway>:8080: i/o timeout` — a
timeout, not a refusal, which is the tell that packets are being dropped
rather than the port being closed. Allow that one path, scoped to the
network's own subnet so 8080 is not opened to anything else:

```bash
SUBNET=$(docker network inspect <compose-network>   --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
ufw allow from "$SUBNET" to any port 8080 proto tcp comment 'rh-oracle upstream from docker'
```

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

## Upstream budget

Alchemy serves state and archive reads; logs come from the public endpoint.
Measured against a 30M compute-unit month:

| | |
|---|---|
| Gas sampling, every 5 min from the tip follower | ~0.9M CU (3%) |
| Left for request traffic | ~29M CU |
| Which is roughly | 160,000 `/quote` calls, or 560,000 `/price` |

The tip poll runs every 5 seconds and deliberately uses the *logs* endpoint,
not Alchemy. Partly cost — it was 17% of the month for a call needing no
archive — but mainly correctness: taking the tip from one node and logs from
another can request a range the log node has not seen yet.

Watch the headroom with Alchemy's own usage page rather than guessing. At the
observed rate this is not the binding constraint; a popular `/quote` would be.

## What runs

| Unit | Kind | Does |
|---|---|---|
| `rh-oracle-api` | always on | serves `/quote`, `/prepare-swap`, `/gas`, `/corporate-actions`, `/coverage`, `/ask` |
| `rh-oracle-watch` | always on | follows the tip for new v4 **and** v3 pools, 5 blocks behind |
| `rh-oracle-sync.timer` | every 6h | registry, corporate calendar, holders, 24h volume |
| `rh-oracle-sample.timer` | every 15min | records what the busiest stock-paired pools are priced at, with the market session on the same row. The only data here that cannot be rebuilt: the public RPC has no archive, so a sweep that does not run is a gap nobody can fill |
| `rh-oracle-agent.timer` | daily 07:30 | scans for signals and queues **drafts** |
| `rh-oracle-admin` | on demand | operator panel on `127.0.0.1:8090`; the only unit holding `BANKR_API_KEY` |

**Nothing on this box can publish.** The agent timer only writes to the
approval queue; sending needs a person to approve a draft and then run
`npm run agent:publish -- --live` by hand. That is deliberate, and it is why
the timer is safe to leave enabled.

## The operator panel

The panel is where the agent's own wallet lives: balances, the approval queue,
creator fees, and token launches. It is a **separate process on loopback**, not
a route on the public API, because the credential it needs can move funds and
the public process must never hold one that can.

Caddy does not publish it. Reach it through an SSH tunnel:

```bash
ssh -L 8090:127.0.0.1:8090 oracle-box     # then open http://127.0.0.1:8090
```

### Three ways to sign in, and why there are three

The gate is always the same check: the server issues a nonce, you sign the
message, it verifies the signature came from an address in `ADMIN_ADDRESSES`.
It never sees a key. What differs is only where the signing happens.

1. **Injected wallet** — a browser extension. The default, and nothing to
   configure.
2. **WalletConnect** — for signing from a phone or another device. Set
   `WALLETCONNECT_PROJECT_ID` (cloud.reown.com) and the button appears;
   leave it empty and it stays hidden. It is off by default on purpose: it
   loads a third-party SDK onto the one page whose process holds the
   wallet-scoped Bankr key, and puts someone else's relay in the sign-in path.
3. **Sign elsewhere and paste it** — needs nothing from the browser at all.
   Paste an owner address, take the message the panel gives you, sign it in
   any wallet or with `cast wallet sign`, paste the signature back. This is
   the route that always works, and the one to reach for when a button will
   not cooperate.

The gate line under the header says what the browser actually offers —
whether an injected wallet was detected, whether WalletConnect is configured,
and whether the page is a secure context, since wallets refuse to connect over
plain `http`. That line exists because "the button does nothing" was reported
twice and diagnosed from the outside both times.

### Two chat boxes, and why they are not the same thing

The panel has both, adjacent and deliberately labelled apart.

**Talk to Bankr** hands your sentence to Bankr's agent, on Bankr's servers,
with the wallet-scoped key. It knows nothing about this service, and with a
read-write key it *executes* — "sell all my BNKR" is a trade, not a question.
Treat it as a command line.

**Ask Vates** runs this service's own identity over this service's own data.
It answers by calling read-only tools against the live database and the Bankr
read endpoints, so every figure in an answer was looked up during that answer
rather than remembered. It cannot trade, publish, or spend: the acting Bankr
functions are not imported into that module at all, which `test/adminChat.test.ts`
asserts by reading the source rather than by trusting the prompt.

It needs `BANKR_LLM_KEY`, which the admin unit already has from `.env`. Without
it the route answers 503 and says so, rather than falling back to something
that looks like an answer.

### Proposed actions

Vates can start a Bankr action but cannot run one. `propose_action` writes a
row to `pending_actions`; the panel renders its parameters verbatim above the
chat; approving runs the call **server-side**, reading the parameters back from
the row. Nothing the model says between proposal and approval reaches the call,
and the approve button sends an id and nothing else.

Two actions exist, and the pair is the point: there is nothing to claim until
something has been launched.

| action | parameters | what moves |
|---|---|---|
| `launch_token` | `tokenName`, `tokenSymbol`, optional `feeRecipient` | deploys a token; `feeRecipient` decides where the creator share goes, and defaults to the agent's wallet |
| `claim_fees` | `tokenAddress` | collects the creator share, towards the agent's own wallet |

`feeRecipient` takes a `0x` address only. Bankr also accepts `x`, `farcaster`
and `ens` recipients; those resolve elsewhere to something the approver cannot
read off the card, which defeats the card.

**Read the parameters, not the reason.** The rationale is the agent's account
of itself. The address is what moves. Approval is claimed in the same statement
that reads the row, so a double-click cannot launch two tokens, and a Bankr
call that errors is left `failed` rather than returned to `pending` — an action
whose effect is unknown must not offer a retry button.

Two relaxations worth knowing about, since they are real:

- Unlike the public `/ask` path, the panel chat is **not** held to
  `verifyDraft` — it may reason, compare and speculate, because nothing it says
  is published. Anything worth posting still goes through the compose form,
  where verification runs exactly as before.
- It can read `README.md`, `CLAUDE.md` and `docs/DEPLOY.md` so it can answer
  questions about intent and recorded measurements. That is an allowlist by
  name, not a path argument: the panel is on the internet, and a tool taking a
  path would be a file-read primitive reachable from a chat box.

### The sampler is the one timer whose misses cost something

Every other job here recomputes a current fact and can catch up. The sampler
writes what a pool was priced at *at a moment*, alongside what the equity
market was doing then, and the public RPC has no archive — so a sweep that
does not run is a gap nobody can fill later, including us. `Persistent=false`
is deliberate for exactly that reason: a catch-up run would write a row
timestamped now and labelled with a session that was not the one it measured,
which is worse than the gap.

```bash
sudo systemctl enable --now rh-oracle-sample.timer
systemctl list-timers rh-oracle-sample.timer
curl -s localhost:8080/health | grep -o '"history":{[^}]*}'   # depth, free
```

`GET /health` publishes how much history exists, so an operator can see the
record growing without paying for `/history`.

`ops/systemd/rh-oracle-admin.service` ships with the rest and is installed by
the deploy, but **not enabled**: a process holding the wallet key has no reason
to run while nobody is looking at it.

```bash
sudo systemctl start rh-oracle-admin     # when you need the panel
sudo systemctl stop  rh-oracle-admin     # when you are done
```

Two gates, not one. The port is not routable, **and** sign-in requires an
address listed in `ADMIN_ADDRESSES` — signed against a different message and a
different secret from the public site, so neither a public session nor a
signature captured there is worth anything here. An empty allowlist means the
panel refuses to start.

### Publishing the panel at a hostname

An ssh tunnel is a poor fit for the panel's daily job, which is approving a
post from wherever you happen to be. The panel can be put behind
`admin.sb4s.xyz` instead — and doing so removes the first of those two gates,
so the second has to carry weight it was not carrying before.

Setting `ADMIN_ALLOW_REMOTE=1` is what turns that on, and it changes the
panel's behaviour rather than only its address:

| | loopback | published |
|---|---|---|
| session cookie | `Secure` optional (the tunnel is http) | `Secure` forced |
| session lifetime | 12h | 2h |
| failed sign-in says | which address is not an owner | `sign-in failed` |
| `/admin/nonce`, `/admin/verify` | unbounded | 30/min and 10/min per client |
| `/admin/health` unauthenticated | owners, key presence, API base | `{ok:true}` |
| `ADMIN_AUTH_SECRET` floor | 16 chars | 32 chars |
| HSTS | no | yes |

Each of those existed as it did *because* the panel was unreachable; the
comments that justified them said so. Binding outward without the flag is a
refusal to start rather than a warning, because the flag is what turns them on.

```bash
# 1. the panel, on an address only Caddy can reach — never 0.0.0.0
docker inspect <caddy-container> \
  --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}'   # e.g. 172.18.0.1

# in /opt/rh-oracle/.env.admin (chmod 600), NOT in the unit file:
#   ADMIN_HOST=172.18.0.1
#   ADMIN_ALLOW_REMOTE=1
#   ADMIN_AUTH_SECRET=<32+ chars — npm run secrets -- --admin>

# 2. a DNS A record for admin.sb4s.xyz pointing at this box

# 3. the site block
cat ops/rh-oracle-admin-docker-caddy.snippet >> "$CF"
docker exec <caddy-container> caddy validate --config /etc/caddy/Caddyfile
docker exec <caddy-container> caddy reload  --config /etc/caddy/Caddyfile

# 4. now it should stay up: a panel that runs only when someone remembers to
#    start it is one nobody can reach from a phone, which was the point.
sudo systemctl enable --now rh-oracle-admin
```

The snippet carries **no** `rate_limit` block, and that is not an oversight:
it is a third-party module the stock Caddy image does not have, and the
directive would make `caddy validate` fail and the reload refuse — turning a
convenience into an outage on a site that was already serving. The panel does
its own limiting in process instead. The existing oracle block has no
`rate_limit` either, which is how you can tell.

`ufw` blocks the Docker bridge the same way it does for the API, so allow that
one path too if it is active:

```bash
SUBNET=$(docker network inspect <compose-network> \
  --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
ufw allow from "$SUBNET" to any port 8090 proto tcp comment 'rh-oracle admin from docker'
```

**What this costs, stated plainly.** The wallet-scoped `BANKR_API_KEY` is now
loaded in a process that is continuously reachable from the internet, where
before it ran only while someone was looking at it. The gate is a signature
from an allowlisted address, and that gate is now the only one. It is a
reasonable trade for a panel whose daily use is approving text, and it is a
trade — worth revisiting if the panel ever gains a route that moves funds
without a second confirmation.

What the panel does, beyond the wallet: a prompt box for **Bankr's own agent**
(balances, fees, a launch, in plain language — and with a read-write key it
executes rather than answers, so every prompt is logged against the address
that sent it); a **composer** for writing a post by hand, held to the same
verifier as a drafted one, queued rather than published; and a **mentions**
view that drafts a reply through the same classifier the webhook uses.

Publishing is there too, on approved posts only: a dry run by default, and a
real send behind a typed confirmation. It is the same `publishPost` the CLI
calls, so `agent:publish -- --live` and the button cannot drift apart. A
channel with no credentials is skipped rather than failed — the post stays
approved instead of being burned.

Launching a token from the panel simulates by default; a real deploy needs the
symbol typed back verbatim. Deploys are irreversible and capped at three
counted attempts per rolling 24 hours per wallet, and on Robinhood Chain they
are not gas-sponsored — the launch wallet needs its own ETH.

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
