#!/usr/bin/env bash
# Starts and seeds the two ClickHouse 26.2 servers behind the playground's data source world,
# or removes them. Then run the playground with PLAYGROUND_CH=1. See src/evals/playground/.
#
#   scripts/data-source-world-ch.sh up     # start (or reuse) and reseed; data is relative to now
#   scripts/data-source-world-ch.sh down   # remove both containers
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="clickhouse/clickhouse-server:26.2"
servers=("main:18741" "staging:18742")

case "${1:-}" in
up)
	for entry in "${servers[@]}"; do
		name="maple-dsworld-${entry%%:*}"
		port="${entry##*:}"
		if ! docker ps --format '{{.Names}}' | grep -qx "$name"; then
			docker rm -f "$name" >/dev/null 2>&1 || true
			docker run -d --name "$name" -p "127.0.0.1:${port}:8123" \
				-e CLICKHOUSE_USER=admin -e CLICKHOUSE_PASSWORD=adminpw \
				-e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 "$IMAGE" >/dev/null
		fi
		for _ in $(seq 1 60); do
			curl -sf "http://127.0.0.1:${port}/ping" >/dev/null && break
			sleep 1
		done
	done
	for entry in "${servers[@]}"; do
		server="${entry%%:*}"
		bun src/mcp/__evals__/ds-world/seed-sql.ts "$server" |
			docker exec -i "maple-dsworld-${server}" clickhouse-client -u admin --password adminpw --multiquery
		echo "seeded ${server} on 127.0.0.1:${entry##*:}"
	done
	;;
down)
	for entry in "${servers[@]}"; do docker rm -f "maple-dsworld-${entry%%:*}" >/dev/null 2>&1 || true; done
	;;
*)
	echo "usage: data-source-world-ch.sh up | down" >&2
	exit 1
	;;
esac
