#!/usr/bin/env bash
# Drive every screen of a Debug build on a simulator, cold, N times, so its
# `screen.ready` / `screen.load` spans land in Maple tagged with one label.
#
#   infisical run --env prod -- apps/ios/scripts/measure-latency.sh \
#     --label branch --udid <sim> --iterations 10 --build --signin you@example.com \
#     --route service/checkout --route issue/<id> --route trace/<id>
#
# --build    builds with MAPLE_ENVIRONMENT=latency-<label> and the public ingest key
#            ($MAPLE_OTEL_PUBLIC_INGEST_KEY), then installs it.
# --org      switches to this organization id first (maple://debug/org/<id>).
# --signin   mints a one-time Clerk sign-in token ($CLERK_SECRET_KEY) and hands it to
#            the app via MAPLE_DEBUG_SIGNIN_TICKET. Only needed once per simulator.
#
# Read the results in Maple, e.g. per screen:
#   SELECT ResourceAttributes['deployment.environment'] run, SpanAttributes['screen.name'] screen,
#     count() n, quantile(0.5)(Duration)/1e6 p50_ms, quantile(0.95)(Duration)/1e6 p95_ms
#   FROM traces WHERE ServiceName = 'maple-ios' AND SpanName = 'screen.ready'
#     AND ResourceAttributes['deployment.environment'] LIKE 'latency-%' GROUP BY run, screen
set -euo pipefail
cd "$(dirname "$0")/.."

label=""
udid=""
iterations=10
build=0
signin=""
org=""
settle=7
routes=(services triage/errors triage/incidents triage/anomalies explore/traces explore/logs explore/dashboards)
bundle=com.maple.mobile

while [[ $# -gt 0 ]]; do
	case "$1" in
	--label) label="$2"; shift 2 ;;
	--udid) udid="$2"; shift 2 ;;
	--iterations) iterations="$2"; shift 2 ;;
	--build) build=1; shift ;;
	--signin) signin="$2"; shift 2 ;;
	--org) org="$2"; shift 2 ;;
	--settle) settle="$2"; shift 2 ;;
	--route) routes+=("$2"); shift 2 ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
[[ -n "$label" && -n "$udid" ]] || { echo "--label and --udid are required" >&2; exit 2; }

derived="/private/tmp/maple-latency-$label"
xcrun simctl boot "$udid" 2>/dev/null || true

if [[ $build == 1 ]]; then
	: "${MAPLE_OTEL_PUBLIC_INGEST_KEY:?run under infisical run --env prod}"
	xcodegen generate -q
	xcodebuild -project Maple.xcodeproj -scheme Maple -configuration Debug \
		-destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$derived" \
		-skipPackagePluginValidation \
		MAPLE_ENVIRONMENT="latency-$label" MAPLE_INGEST_KEY="$MAPLE_OTEL_PUBLIC_INGEST_KEY" \
		build | grep -E " error:|BUILD (SUCCEEDED|FAILED)"
	xcrun simctl install "$udid" "$derived/Build/Products/Debug-iphonesimulator/Maple.app"
fi

if [[ -n "$signin" ]]; then
	: "${CLERK_SECRET_KEY:?run under infisical run --env prod}"
	user_id=$(curl -sf -G https://api.clerk.com/v1/users --data-urlencode "email_address=$signin" \
		-H "Authorization: Bearer $CLERK_SECRET_KEY" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
	ticket=$(curl -sf https://api.clerk.com/v1/sign_in_tokens -H "Authorization: Bearer $CLERK_SECRET_KEY" \
		-H "Content-Type: application/json" -d "{\"user_id\":\"$user_id\",\"expires_in_seconds\":300}" |
		python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
	xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true
	SIMCTL_CHILD_MAPLE_DEBUG_SIGNIN_TICKET="$ticket" xcrun simctl launch "$udid" "$bundle" >/dev/null
	unset ticket
	sleep 15
	echo "signed in"
fi

# Pin the organization before measuring; the choice persists in the Clerk session.
if [[ -n "$org" ]]; then
	xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true
	xcrun simctl launch "$udid" "$bundle" >/dev/null
	sleep "$settle"
	xcrun simctl openurl "$udid" "maple://debug/org/$org"
	sleep 10
fi

for ((i = 1; i <= iterations; i++)); do
	xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true
	xcrun simctl launch "$udid" "$bundle" >/dev/null
	sleep "$settle"
	for route in "${routes[@]}"; do
		xcrun simctl openurl "$udid" "maple://debug/$route"
		sleep "$settle"
	done
	# Background the app so the SDK flushes its spans before the process goes.
	xcrun simctl launch "$udid" com.apple.Preferences >/dev/null
	sleep 5
	echo "iteration $i/$iterations done"
done
xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true
