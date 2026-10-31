#!/usr/bin/env bash
# End-to-end check of the self-hosted image: refuses to start without secrets,
# serves authenticated ingest and reads, runs unprivileged on a root-owned
# volume, answers `docker exec … maple`, and keeps its data across a restart.
#
# Usage: apps/cli/docker/image-smoke.sh <image> [host-port]
set -euo pipefail

IMAGE="${1:?usage: image-smoke.sh <image> [host-port]}"
PORT="${2:-45261}"
RUN_ID="maple-image-smoke-$$"
VOLUME="$RUN_ID-data"
BASE="http://127.0.0.1:$PORT"
INGEST_KEY="smoke-ingest-key-$(openssl rand -hex 8)"
ACCESS_TOKEN="smoke-access-token-$(openssl rand -hex 8)"
BODY="$(mktemp)"

cleanup() {
	docker rm -f "$RUN_ID" >/dev/null 2>&1 || true
	docker volume rm "$VOLUME" >/dev/null 2>&1 || true
	rm -f "$BODY"
}
trap cleanup EXIT

fail() {
	echo "FAIL: $*" >&2
	docker logs "$RUN_ID" 2>&1 | tail -40 >&2 || true
	exit 1
}

pass() {
	echo "ok - $*"
}

wait_health() {
	for _ in $(seq 1 300); do
		if curl -fsS --max-time 2 "$BASE/health" >/dev/null 2>&1; then
			return
		fi
		sleep 0.2
	done
	fail "container did not become healthy"
}

status_of() {
	curl -sS --max-time 10 -o "$BODY" -w '%{http_code}' "$@"
}

span_json() {
	local now
	now="$(date +%s)000000000"
	jq -nc --arg now "$now" --arg trace "$(openssl rand -hex 16)" --arg span "$(openssl rand -hex 8)" '{
		resourceSpans: [{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "image-smoke" } }] },
			scopeSpans: [{ spans: [{ traceId: $trace, spanId: $span, name: "GET /smoke", kind: 2,
				startTimeUnixNano: $now, endTimeUnixNano: $now }] }]
		}]
	}'
}

span_count() {
	status_of -X POST "$BASE/local/query" -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \
		--data '{"sql":"SELECT count() AS n FROM traces WHERE OrgId = '\''local'\'' AND ServiceName = '\''image-smoke'\''"}' >/dev/null
	jq -r '.[0].n' "$BODY"
}

# --- Missing secrets: refuse with an actionable message.
if docker run --rm "$IMAGE" >"$BODY" 2>&1; then
	fail "the image started without MAPLE_LOCAL_INGEST_KEY"
fi
grep -q "MAPLE_LOCAL_INGEST_KEY is required" "$BODY" || fail "missing-secret error was unclear: $(cat "$BODY")"
pass "refuses to start without secrets"

# --- A root-owned volume, as platforms mount them.
docker volume create "$VOLUME" >/dev/null
docker run --rm -v "$VOLUME:/data" --entrypoint chown "$IMAGE" -R 0:0 /data

docker run -d --name "$RUN_ID" -p "127.0.0.1:$PORT:8080" -e PORT=8080 \
	-e MAPLE_LOCAL_INGEST_KEY="$INGEST_KEY" -e MAPLE_LOCAL_ACCESS_TOKEN="$ACCESS_TOKEN" -e MAPLE_TELEMETRY=off \
	-v "$VOLUME:/data" "$IMAGE" >/dev/null
wait_health
pass "starts on a root-owned volume and honours PORT"

uid="$(docker exec "$RUN_ID" sh -c 'stat -c %u /proc/1')"
[[ "$uid" == 10001 ]] || fail "the server runs as uid $uid, not 10001"
pass "server runs unprivileged (uid 10001)"

# --- Auth through the published port.
[[ "$(status_of "$BASE/v1/traces" -H 'content-type: application/json' --data "$(span_json)")" == 401 ]] ||
	fail "OTLP without the ingest key was accepted"
for _ in 1 2 3; do
	[[ "$(status_of "$BASE/v1/traces" -H 'content-type: application/json' -H "authorization: Bearer $INGEST_KEY" \
		--data "$(span_json)")" == 200 ]] || fail "OTLP with the ingest key was refused: $(cat "$BODY")"
done
[[ "$(status_of "$BASE/local/status")" == 401 ]] || fail "reads were open without the access token"
[[ "$(span_count)" == 3 ]] || fail "expected 3 spans, got $(cat "$BODY")"
[[ "$(status_of -X POST "$BASE/local/auth/login" --data-urlencode "token=$ACCESS_TOKEN")" == 303 ]] ||
	fail "sign-in with the access token failed"
pass "ingest key and access token enforced through the published port"

# --- CLI inside the container inherits the token and finds the server.
docker exec "$RUN_ID" maple services --format json >"$BODY" 2>&1 || fail "docker exec maple services failed: $(cat "$BODY")"
grep -q image-smoke "$BODY" || fail "docker exec maple services did not list the service: $(cat "$BODY")"
pass "docker exec maple services works"

# --- A stop within Docker's default grace period, and the data survives it.
started="$(date +%s)"
docker stop "$RUN_ID" >/dev/null
elapsed=$(($(date +%s) - started))
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$RUN_ID")"
[[ "$exit_code" == 0 ]] || fail "docker stop exited $exit_code (after ${elapsed}s), not a clean shutdown"
pass "docker stop shuts down cleanly in ${elapsed}s"

docker start "$RUN_ID" >/dev/null
wait_health
[[ "$(span_count)" == 3 ]] || fail "spans did not survive a restart: $(cat "$BODY")"
# Logs go through a file: `docker logs | grep -q` fails under pipefail on a match.
docker logs "$RUN_ID" >"$BODY" 2>&1
if grep -q "unclean shutdown" "$BODY"; then
	fail "the restart treated a docker stop as an unclean shutdown"
fi
pass "data survives a restart without recovery"

# --- Killed mid-run (OOM, host crash): starts from its restore point instead of refusing.
# The restart above may still be taking its own first checkpoint; wait out its lock, including
# the moment between creating the lock and writing its owner record ("ownership is uncertain").
checkpointed=0
for _ in $(seq 1 60); do
	if docker exec -u 10001 "$RUN_ID" maple checkpoint >"$BODY" 2>&1; then
		checkpointed=1
		break
	fi
	grep -q -E "maintenance operation is active|ownership is uncertain" "$BODY" || break
	sleep 0.5
done
[[ "$checkpointed" == 1 ]] || fail "maple checkpoint failed: $(cat "$BODY")"
docker kill "$RUN_ID" >/dev/null
docker start "$RUN_ID" >/dev/null
wait_health
docker logs "$RUN_ID" >"$BODY" 2>&1
grep -q "restoring the last checkpoint" "$BODY" ||
	fail "a killed container did not restore its checkpoint"
[[ "$(status_of "$BASE/local/status" -H "authorization: Bearer $ACCESS_TOKEN")" == 200 ]] ||
	fail "the restored server did not answer"
pass "a killed container recovers from its restore point"

# --- Killed before its first restore point: nothing to recover, so it starts fresh.
docker rm -f "$RUN_ID" >/dev/null
docker volume rm "$VOLUME" >/dev/null
docker run -d --name "$RUN_ID" -p "127.0.0.1:$PORT:4318" \
	-e MAPLE_LOCAL_INGEST_KEY="$INGEST_KEY" -e MAPLE_LOCAL_ACCESS_TOKEN="$ACCESS_TOKEN" -e MAPLE_TELEMETRY=off \
	-v "$VOLUME:/data" "$IMAGE" >/dev/null
wait_health
docker kill "$RUN_ID" >/dev/null
docker start "$RUN_ID" >/dev/null
wait_health
pass "a container killed before its first restore point still starts"

echo "image smoke passed"
