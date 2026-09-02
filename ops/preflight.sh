#!/usr/bin/env bash
# Read-only survey of a server that already runs something else.
#
# Changes nothing. Run it before deploying and read the output: this project
# assumes it can take a port, install Node, and reload a web server, and every
# one of those can break an existing tenant on a shared box.
#
#   bash ops/preflight.sh          (on the server)
set -uo pipefail

say() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  OK      %s\n' "$1"; }
warn() { printf '  CHECK   %s\n' "$1"; }
bad()  { printf '  CONFLICT %s\n' "$1"; }

say "node"
if command -v node >/dev/null 2>&1; then
	v=$(node --version)
	major=${v#v}; major=${major%%.*}
	if [ "$major" -ge 22 ]; then
		ok "node $v (>=22 required) — nothing to install"
	else
		bad "node $v is already installed and something may depend on it."
		echo "          Installing Node 22 from NodeSource REPLACES it system-wide."
		echo "          Safer: install 22 via fnm/nvm for the oracle user only and"
		echo "          point ExecStart at that binary instead of /usr/bin/node."
	fi
else
	ok "no system node — a clean Node 22 install is safe"
fi

say "port 8080"
if ss -ltnp 2>/dev/null | grep -q ':8080 '; then
	bad "something already listens on 8080:"
	ss -ltnp 2>/dev/null | grep ':8080 ' | sed 's/^/          /'
	echo "          Set PORT to a free port in /opt/rh-oracle/.env and match it"
	echo "          in the reverse_proxy line of the Caddy snippet."
else
	ok "8080 is free"
fi

say "who owns 80/443"
# Checked before the systemd sweep below, because on a Docker host the proxy
# is a container and systemctl knows nothing about it -- a survey that only
# asked systemd would report "no web server" on a box actively serving one.
if ss -ltnp 2>/dev/null | grep -qE ':(80|443) '; then
	ss -ltnp 2>/dev/null | grep -E ':(80|443) ' | sed 's/^/  /'
	if ss -ltnp 2>/dev/null | grep -E ':(80|443) ' | grep -qi 'docker\|proxy'; then
		warn "ports 80/443 are held by Docker — the reverse proxy is a container."
		echo "          Caddy cannot be installed alongside it; it would fail to bind."
		echo "          Add a vhost to the existing container instead, proxying to"
		echo "          the oracle on 127.0.0.1:\$PORT."
	fi
else
	ok "80/443 are free"
fi

say "docker"
if command -v docker >/dev/null 2>&1; then
	warn "docker is installed — the other project probably runs in it"
	docker ps --format '  {{.Names}}	{{.Image}}	{{.Ports}}' 2>/dev/null | head -20 		|| echo "          (cannot list containers as this user)"
	if [ -n "$(docker ps -q --filter 'publish=80' 2>/dev/null)" ] || 	   [ -n "$(docker ps -q --filter 'publish=443' 2>/dev/null)" ]; then
		echo "          A container publishes 80 and/or 443. That container is the"
		echo "          reverse proxy; the oracle needs a vhost in ITS config, not a"
		echo "          new Caddy on the host."
	fi
	for f in /root/docker-compose.yml /root/compose.yaml /opt/*/docker-compose.yml /srv/*/docker-compose.yml; do
		[ -f "$f" ] && echo "          compose file: $f"
	done
else
	ok "no docker"
fi

say "systemd web servers"
for svc in caddy nginx apache2 httpd traefik; do
	if systemctl is-active --quiet "$svc" 2>/dev/null; then
		warn "$svc is running and is serving the existing site(s)"
		if [ "$svc" = "caddy" ]; then
			if grep -q 'import .*conf\.d' /etc/caddy/Caddyfile 2>/dev/null; then
				ok "  /etc/caddy/Caddyfile already imports conf.d — drop the snippet in"
			else
				warn "  /etc/caddy/Caddyfile has no conf.d import."
				echo "          Add this line at the TOP LEVEL (outside any site block):"
				echo "            import /etc/caddy/conf.d/*.caddy"
				echo "          Never overwrite the existing Caddyfile."
			fi
			echo "          Sites currently configured:"
			grep -oE '^[a-z0-9.*-]+\.[a-z]{2,}' /etc/caddy/Caddyfile 2>/dev/null | sed 's/^/            /' || true
		else
			warn "  This project ships a Caddy snippet. With $svc in front instead,"
			echo "          add an equivalent vhost proxying to 127.0.0.1:\$PORT rather"
			echo "          than installing Caddy alongside — two things cannot both"
			echo "          bind 443."
		fi
	fi
done
if ! systemctl is-active --quiet caddy nginx apache2 httpd traefik 2>/dev/null; then
	echo "  (none running under systemd — see the Docker section above)"
fi

say "firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
	ok "ufw is already active — do NOT re-run 'ufw enable' or reset the rules"
	ufw status numbered 2>/dev/null | sed 's/^/          /'
	echo "          Confirm the existing project's ports are in that list before"
	echo "          changing anything."
else
	warn "ufw inactive. Enabling it will drop every port you do not allow —"
	echo "          list the other project's ports first."
fi

say "disk"
df -h / | sed 's/^/  /'
echo "  The index needs ~350 MB now and grows ~10 GB/year."

say "memory"
free -h 2>/dev/null | sed 's/^/  /'
echo "  The hourly volume sync peaks around 300 MB on top of the other tenant."

say "existing oracle user"
if id oracle >/dev/null 2>&1; then
	warn "user 'oracle' already exists — confirm it is not in use by something else"
else
	ok "no 'oracle' user yet"
fi

say "summary"
echo "  Resolve every CONFLICT above before running ops/deploy.sh."
echo "  CHECK lines need a human decision, not necessarily a change."
