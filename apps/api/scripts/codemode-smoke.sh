#!/usr/bin/env bash
# Local smoke test for Code Mode (Cloudflare Worker Loader).
#
# Worker Loader / Dynamic Workers runs in local workerd, so the whole Code Mode
# path is testable without deploying. Bindings come from apps/api/wrangler.jsonc
# (LOADER + CODEMODE_RUNTIME DO + SELF), so this works under plain `wrangler dev`.
#
# Usage:
#   # 1. start the api worker (from apps/api):
#   bunx wrangler dev --env-file=../../.env.local --port 3472
#   # 2. in another shell:
#   apps/api/scripts/codemode-smoke.sh
#
# Reads INTERNAL_SERVICE_TOKEN + MAPLE_ORG_ID_OVERRIDE from the env (mise loads
# .env.local); override BASE/ORG/TOKEN inline if needed.
set -euo pipefail

BASE="${BASE:-http://localhost:3472}"
TOKEN="${TOKEN:-${INTERNAL_SERVICE_TOKEN:-}}"
ORG="${ORG:-${MAPLE_ORG_ID_OVERRIDE:-}}"

if [[ -z "$TOKEN" || -z "$ORG" ]]; then
	echo "Set INTERNAL_SERVICE_TOKEN and MAPLE_ORG_ID_OVERRIDE (or TOKEN/ORG) in the env." >&2
	exit 1
fi

AUTH="authorization: Bearer maple_svc_${TOKEN}"
ORGH="x-org-id: ${ORG}"

run() { # <label> <json-code>
	echo "── $1"
	curl -s -m 40 -X POST "$BASE/internal/codemode/run" \
		-H "content-type: application/json" -H "$AUTH" -H "$ORGH" \
		-d "{\"code\":$2}" | head -c 700
	echo; echo
}

echo "== Code Mode local smoke test ($BASE) =="
echo

run "progressive discovery (codemode.search)" '"return await codemode.search(\"errors slow traces\");"'
run "single read tool (full dispatch)" '"return (await maple.list_services({})).slice(0, 200);"'
run "multi-step chain in one snippet" '"const s = await maple.list_services({}); const e = await maple.find_errors({ lookbackMinutes: 60 }); return { s: s.slice(0,120), e: String(e).slice(0,160) };"'
run "mutating tool is unreachable from the sandbox" '"try { await maple.create_alert_rule({}); return \"REACHED — BAD\"; } catch (e) { return \"blocked: \" + e.message; }"'

echo "── /tool rejects mutating names directly (expect HTTP 403)"
curl -s -m 10 -o /dev/null -w "  HTTP %{http_code}\n" -X POST "$BASE/internal/codemode/tool" \
	-H "content-type: application/json" -H "$AUTH" -H "$ORGH" \
	-d '{"name":"delete_alert_rule","arguments":{}}'

echo "── auth rejected without token (expect HTTP 401)"
curl -s -m 10 -o /dev/null -w "  HTTP %{http_code}\n" -X POST "$BASE/internal/codemode/run" \
	-H "content-type: application/json" -H "$ORGH" -d '{"code":"return 1"}'

echo; echo "done."
