#!/usr/bin/env bash
# Drive every screen of a Debug build on a simulator, cold, N times, so its
# `screen.ready` / `screen.load` spans land in Maple tagged with one label.
#
#   infisical run --env dev -- apps/ios/scripts/measure-latency.sh \
#     --label branch --udid <sim> --iterations 10 --build --signin you+clerk_test@example.com \
#     --api https://api-pr-<n>.maple.dev --clerk-key pk_test_... \
#     --route service/checkout --route issue/<id> --route trace/<id>
#
# Development only: it runs against the Clerk development instance and a dev or preview API,
# and refuses a live Clerk key, so it can never sign in as a production user.
# Without --build it measures the app already installed, with that app's own API, Clerk
# instance and session; build with --build first to be sure it targets a dev instance.
#
# --build    builds with MAPLE_ENVIRONMENT=latency-<label> and the public ingest key
#            ($MAPLE_OTEL_PUBLIC_INGEST_KEY), then installs it.
# --api, --clerk-key  point the build at another API and its Clerk instance (a PR
#            preview: https://api-pr-<n>.maple.dev and the dev publishable key).
# --org      switches to this organization id first (maple://debug/org/<id>).
# --signin   mints a one-time Clerk sign-in token with the development $CLERK_SECRET_KEY
#            (sk_test_ only) and hands it to the app via MAPLE_DEBUG_SIGNIN_TICKET. Only
#            needed once per simulator.
#
# Read the results in Maple, e.g. per screen:
#   SELECT ResourceAttributes['deployment.environment'] run, SpanAttributes['screen.name'] screen,
#     count() n, quantile(0.5)(Duration)/1e6 p50_ms, quantile(0.95)(Duration)/1e6 p95_ms
#   FROM traces WHERE ServiceName = 'maple-ios' AND SpanName = 'screen.ready'
#     AND SpanAttributes['load.outcome'] IN ('loaded', 'empty', 'failed')
#     AND ResourceAttributes['deployment.environment'] LIKE 'latency-%' GROUP BY run, screen
set -euo pipefail
cd "$(dirname "$0")/.."

label=""
udid=""
iterations=10
build=0
signin=""
org=""
api=""
clerk_key=""
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
	--api) api="$2"; shift 2 ;;
	--clerk-key) clerk_key="$2"; shift 2 ;;
	--settle) settle="$2"; shift 2 ;;
	--route) routes+=("$2"); shift 2 ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
[[ -n "$label" && -n "$udid" ]] || { echo "--label and --udid are required" >&2; exit 2; }
# Development instances only: a live key or the production API is refused outright.
# A build must name both, or Xcode falls back to the production defaults.
if [[ $build == 0 && ( -n "$api" || -n "$clerk_key" ) ]]; then
	echo "--api and --clerk-key only apply with --build; the installed app keeps its own settings" >&2; exit 2
fi
if [[ $build == 1 && ( -z "$api" || -z "$clerk_key" ) ]]; then
	echo "--build needs --api (dev or preview) and --clerk-key (pk_test_...)" >&2; exit 2
fi
if [[ -n "$clerk_key" && "$clerk_key" != pk_test_* ]]; then
	echo "--clerk-key must be a development publishable key (pk_test_...)" >&2; exit 2
fi
if [[ -n "$api" ]]; then
	api_host="${api#*://}"; api_host="${api_host%%[/?#]*}"; api_host="${api_host##*@}"; api_host="${api_host%%:*}"; api_host="${api_host%.}"
	# Plain host names only: an encoded or unusual spelling could still resolve to production.
	if [[ ! "$api_host" =~ ^[A-Za-z0-9.-]+$ ]]; then
		echo "--api host must be a plain host name" >&2; exit 2
	fi
	case "$(printf %s "$api_host" | tr "[:upper:]" "[:lower:]")" in
	maple.dev | api.maple.dev | api.eu.maple.dev | app.maple.dev | app.eu.maple.dev | "")
		echo "--api must be a dev or preview API, not production" >&2; exit 2 ;;
	esac
fi

derived="/private/tmp/maple-latency-$label"
xcrun simctl boot "$udid" 2>/dev/null || true

if [[ $build == 1 ]]; then
	: "${MAPLE_OTEL_PUBLIC_INGEST_KEY:?set MAPLE_OTEL_PUBLIC_INGEST_KEY to the public ingest key the spans go to}"
	xcodegen generate -q
	xcodebuild -project Maple.xcodeproj -scheme Maple -configuration Debug \
		-destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$derived" \
		-skipPackagePluginValidation \
		MAPLE_ENVIRONMENT="latency-$label" MAPLE_INGEST_KEY="$MAPLE_OTEL_PUBLIC_INGEST_KEY" \
		${api:+MAPLE_API_BASE_URL="$api"} ${clerk_key:+CLERK_PUBLISHABLE_KEY="$clerk_key"} \
		build | grep -E " error:|BUILD (SUCCEEDED|FAILED)"
	xcrun simctl install "$udid" "$derived/Build/Products/Debug-iphonesimulator/Maple.app"
fi

if [[ -n "$signin" ]]; then
	: "${CLERK_SECRET_KEY:?run under infisical run --env dev}"
	if [[ "$CLERK_SECRET_KEY" != sk_test_* ]]; then
		echo "CLERK_SECRET_KEY is not a development key (sk_test_...). --signin only works on dev instances." >&2
		exit 2
	fi
	# The secret goes to curl on stdin, never in argv where `ps` would show it.
	auth="Authorization: Bearer $CLERK_SECRET_KEY"
	user_id=$(curl -sf -G https://api.clerk.com/v1/users --data-urlencode "email_address=$signin" -H @- <<<"$auth" |
		python3 -c 'import json,sys; users=json.load(sys.stdin); print(users[0]["id"] if users else "")')
	[[ -n "$user_id" ]] || { echo "no Clerk user with email $signin" >&2; exit 1; }
	ticket=$(curl -sf https://api.clerk.com/v1/sign_in_tokens -H @- -H "Content-Type: application/json" \
		-d "{\"user_id\":\"$user_id\",\"expires_in_seconds\":300}" <<<"$auth" |
		python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
	unset auth
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
