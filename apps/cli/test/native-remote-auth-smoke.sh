#!/usr/bin/env bash
# End-to-end check of a self-hosted `maple start`: the ingest key guards OTLP,
# the access token guards reads (sign-in page, session cookie, Bearer), and the
# CLI and `maple checkpoint` keep working against the authenticated server.
set -euo pipefail

BUNDLE_DIR="${1:?usage: native-remote-auth-smoke.sh <bundle-dir> [port]}"
MAPLE="$BUNDLE_DIR/maple"
PORT="${2:-45241}"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/maple-native-remote-auth.XXXXXX")"
DATA="$ROOT/data"
BASE="http://127.0.0.1:$PORT"
INGEST_KEY="smoke-ingest-key-$(openssl rand -hex 8)"
ACCESS_TOKEN="smoke-access-token-$(openssl rand -hex 8)"
SERVER_PID=""

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		for _ in $(seq 1 50); do
			kill -0 "$SERVER_PID" 2>/dev/null || break
			sleep 0.1
		done
		kill -9 "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	if [[ "${KEEP_ROOT:-0}" == "1" ]]; then
		echo "preserved smoke root: $ROOT" >&2
	else
		rm -rf "$ROOT"
	fi
}
trap cleanup EXIT

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

pass() {
	echo "ok - $*"
}

wait_health() {
	for _ in $(seq 1 200); do
		if curl -fsS --max-time 2 "$BASE/health" >/dev/null 2>&1; then
			return
		fi
		sleep 0.1
	done
	fail "server did not become healthy; log follows: $(tail -80 "$ROOT/server.log" 2>/dev/null)"
}

start_server() {
	"$MAPLE" start --host 0.0.0.0 --port "$PORT" --data-dir "$DATA" --checkpoint-interval off --offline \
		>"$ROOT/server.log" 2>&1 &
	SERVER_PID=$!
	wait_health
}

stop_server() {
	"$MAPLE" stop --data-dir "$DATA" >/dev/null
	for _ in $(seq 1 300); do
		kill -0 "$SERVER_PID" 2>/dev/null || break
		sleep 0.1
	done
	kill -0 "$SERVER_PID" 2>/dev/null && fail "server did not exit within 30s of maple stop"
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
}

# status <expected> <curl args...>: the HTTP status of one request.
expect_status() {
	local expected="$1"
	shift
	local got
	got="$(curl -sS --max-time 10 -o "$ROOT/body" -w '%{http_code}' "$@")"
	[[ "$got" == "$expected" ]] || fail "expected $expected, got $got for: $* ($(head -c 300 "$ROOT/body"))"
}

span_json() {
	local now
	now="$(date +%s)000000000"
	jq -nc --arg now "$now" --arg trace "$(openssl rand -hex 16)" --arg span "$(openssl rand -hex 8)" '{
		resourceSpans: [{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "remote-auth-smoke" } }] },
			scopeSpans: [{ spans: [{ traceId: $trace, spanId: $span, name: "GET /smoke", kind: 2,
				startTimeUnixNano: $now, endTimeUnixNano: $now }] }]
		}]
	}'
}

ingest() {
	curl -sS --max-time 10 -o "$ROOT/body" -w '%{http_code}' "$BASE/v1/traces" \
		-H 'content-type: application/json' "$@" --data "$(span_json)"
}

query_body() {
	jq -nc --arg sql "$1" '{sql:$sql}'
}

# --- Open server off loopback: starts, but the banner says what is exposed.
start_server
grep -q "open to anyone who can reach this address" "$ROOT/server.log" ||
	fail "an unauthenticated non-loopback start did not warn: $(cat "$ROOT/server.log")"
pass "unauthenticated non-loopback start warns"
stop_server

# --- A short secret is refused before anything opens.
if MAPLE_LOCAL_ACCESS_TOKEN=short "$MAPLE" start --port "$PORT" --data-dir "$DATA" --offline >"$ROOT/short.log" 2>&1; then
	fail "a 5-character access token was accepted"
fi
grep -q "MAPLE_LOCAL_ACCESS_TOKEN must be at least 16 characters" "$ROOT/short.log" ||
	fail "short-token error did not name the variable: $(cat "$ROOT/short.log")"
pass "short access token refused"

export MAPLE_LOCAL_INGEST_KEY="$INGEST_KEY" MAPLE_LOCAL_ACCESS_TOKEN="$ACCESS_TOKEN"
start_server
grep -q "ingest key + access token" "$ROOT/server.log" || fail "banner did not report auth: $(cat "$ROOT/server.log")"
pass "authenticated start reports both secrets"

expect_status 200 "$BASE/health"
pass "/health stays open"

# --- Ingest key.
[[ "$(ingest)" == 401 ]] || fail "OTLP without a key was accepted"
[[ "$(ingest -H "authorization: Bearer wrong-key-0123456789")" == 401 ]] || fail "OTLP with a wrong key was accepted"
[[ "$(ingest -H "authorization: Bearer $ACCESS_TOKEN")" == 401 ]] || fail "the access token was accepted as an ingest key"
[[ "$(ingest -H "authorization: Bearer $INGEST_KEY")" == 200 ]] || fail "OTLP with the Bearer ingest key was refused: $(cat "$ROOT/body")"
[[ "$(ingest -H "x-maple-ingest-key: $INGEST_KEY")" == 200 ]] || fail "OTLP with x-maple-ingest-key was refused: $(cat "$ROOT/body")"
pass "ingest key required on /v1/traces, both header forms accepted"

# --- Reads.
COUNT_SQL="SELECT count() AS n FROM traces WHERE OrgId = 'local' AND ServiceName = 'remote-auth-smoke'"
expect_status 401 "$BASE/local/status"
expect_status 401 -X POST "$BASE/local/query" -H 'content-type: application/json' --data "$(query_body "$COUNT_SQL")"
expect_status 401 "$BASE/local/status" -H "authorization: Bearer $INGEST_KEY"
expect_status 200 "$BASE/local/status" -H "authorization: Bearer $ACCESS_TOKEN"
pass "reads need the access token; the ingest key cannot read"

expect_status 303 "$BASE/"
curl -sS -o /dev/null -D "$ROOT/headers" "$BASE/traces"
grep -qi '^location: /login' "$ROOT/headers" || fail "a signed-out page load was not sent to /login"
expect_status 200 "$BASE/login"
grep -q 'name="token"' "$ROOT/body" || fail "/login is not the sign-in form"
curl -sS -o /dev/null -D "$ROOT/headers" "$BASE/local/auth/login"
grep -qi '^location: /login' "$ROOT/headers" || fail "reloading a failed sign-in did not return to /login"
pass "signed-out page loads go to the sign-in page"

# --- Sign in through the form, as a browser on an unadvertised platform hostname would.
HOST_HEADERS=(-H "Host: maple.smoke.test" -H "Origin: http://maple.smoke.test")
expect_status 401 -X POST "$BASE/local/auth/login" "${HOST_HEADERS[@]}" --data-urlencode "token=wrong-token-0123456789" --data-urlencode "next=/"
expect_status 303 -X POST "$BASE/local/auth/login" "${HOST_HEADERS[@]}" -c "$ROOT/cookies" \
	--data-urlencode "token=$ACCESS_TOKEN" --data-urlencode "next=/"
grep -q maple_local_session "$ROOT/cookies" || fail "sign-in did not set the session cookie"
expect_status 200 -X POST "$BASE/local/query" "${HOST_HEADERS[@]}" -b "$ROOT/cookies" \
	-H 'content-type: application/json' --data "$(query_body "$COUNT_SQL")"
[[ "$(jq -r '.[0].n' "$ROOT/body")" == 2 ]] || fail "expected the 2 ingested spans, got $(cat "$ROOT/body")"
expect_status 403 -X POST "$BASE/local/query" -H "Host: maple.smoke.test" -H "Origin: http://evil.example" \
	-b "$ROOT/cookies" -H 'content-type: application/json' --data "$(query_body "$COUNT_SQL")"
expect_status 200 "$BASE/" -H "Host: maple.smoke.test" -b "$ROOT/cookies"
grep -q '<div id="app">' "$ROOT/body" || fail "signed-in / did not serve the dashboard"
pass "sign-in sets a session that reads data on a platform hostname; other origins stay refused"

# --- The CLI signs its own requests with MAPLE_LOCAL_ACCESS_TOKEN.
MAPLE_LOCAL_URL="$BASE" "$MAPLE" services --format json >"$ROOT/services.json" 2>"$ROOT/services.err" ||
	fail "maple services failed with the access token: $(cat "$ROOT/services.err")"
grep -q remote-auth-smoke "$ROOT/services.json" || fail "maple services did not list the ingested service"
if MAPLE_LOCAL_URL="$BASE" MAPLE_LOCAL_ACCESS_TOKEN="" "$MAPLE" services --format json >/dev/null 2>&1; then
	fail "maple services succeeded without the access token"
fi
pass "CLI queries succeed with the token and fail without it"

# --- Maintenance through the server's own token still works.
"$MAPLE" checkpoint --port "$PORT" --data-dir "$DATA" >"$ROOT/checkpoint.out" 2>&1 ||
	fail "maple checkpoint failed against an authenticated server: $(cat "$ROOT/checkpoint.out")"
pass "maple checkpoint works with auth on"

stop_server
echo "remote auth smoke passed"
