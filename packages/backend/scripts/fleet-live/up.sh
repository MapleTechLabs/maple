#!/usr/bin/env bash
# Starts real Fleet servers in Docker, each with four enrolled devices, fleets and policies, and
# prints what FleetFindingsService.live.e2e.test.ts needs to read them.
#
#   ./up.sh v4.95.0:8495:premium rc-minor-fleet-v5.0.0:8500:premium v4.95.0:8496:free
#   ./up.sh down
#
# Each argument is <fleetdm/fleet image tag>:<local port>:<premium|free>. Premium uses Fleet's own
# development license (`fleet serve --dev_license`). Needs docker, curl, jq and openssl.
set -euo pipefail
cd "$(dirname "$0")"
STATE=.state
PASSWORD='Local-Only-Passw0rd!x'

project() { echo "fleetlive$1"; }

compose() { # compose <port> <args...>
	local port=$1
	shift
	docker compose -p "$(project "$port")" --env-file "$STATE/env-$port" "$@"
}

if [ "${1:-}" = down ]; then
	for env in "$STATE"/env-*; do
		[ -e "$env" ] || continue
		port=${env##*env-}
		ENROLL_SECRET=unset compose "$port" --profile devices down -v --remove-orphans
	done
	rm -rf "$STATE"
	exit 0
fi

mkdir -p "$STATE"
if [ ! -e "$STATE/fleet.crt" ]; then
	openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout "$STATE/fleet.key" -out "$STATE/fleet.crt" \
		-subj "/CN=fleet" -addext "subjectAltName=DNS:fleet,DNS:localhost,IP:127.0.0.1" 2>/dev/null
	chmod 644 "$STATE/fleet.key"
fi

# call <port> <token> <METHOD> <path> [json]: sets STATUS and BODY.
call() {
	local port=$1 token=$2 method=$3 path=$4 body=${5:-} out
	local args=(-sk --max-time 60 -X "$method" "https://localhost:$port$path" -H "authorization: Bearer $token" -w $'\n%{http_code}')
	if [ -n "$body" ]; then args+=(-H 'content-type: application/json' -d "$body"); fi
	out=$(curl "${args[@]}")
	STATUS=${out##*$'\n'}
	BODY=${out%$'\n'*}
}

ok() { # ok <what>: the last call must have answered 200
	if [ "$STATUS" != 200 ]; then
		echo "  $1 failed: $STATUS $BODY" >&2
		exit 1
	fi
}

login() { # login <port> <email> <password>
	curl -sk --max-time 30 -X POST "https://localhost:$1/api/v1/fleet/login" -H 'content-type: application/json' \
		-d "$(jq -cn --arg e "$2" --arg p "$3" '{email:$e,password:$p}')" | jq -r '.token // empty'
}

seed() { # seed <tag> <port> <tier>
	local tag=$1 port=$2 tier=$3 flags=""
	if [ -e "$STATE/target-$port.json" ]; then
		echo "== $tag on https://localhost:$port is already seeded" >&2
		return
	fi
	[ "$tier" = premium ] && flags="--dev_license"
	printf 'FLEET_IMAGE=fleetdm/fleet:%s\nFLEET_PORT=%s\nFLEET_SERVE_FLAGS=%s\nFLEET_SUBNET=10.211.%s.0/24\n' \
		"$tag" "$port" "$flags" "$((port % 250))" >"$STATE/env-$port"
	echo "== $tag ($tier) on https://localhost:$port" >&2
	compose "$port" up -d fleet >&2
	until curl -sk --max-time 3 "https://localhost:$port/setup" -o /dev/null; do sleep 3; done

	curl -sk --max-time 60 -X POST "https://localhost:$port/api/v1/setup" -H 'content-type: application/json' -o /dev/null -d "$(jq -cn --arg p "$PASSWORD" \
		'{admin:{admin:true,email:"admin@example.com",name:"Admin",password:$p,password_confirmation:$p},org_info:{org_name:"Acme Corp"},server_url:"https://fleet:8080"}')"
	local admin
	admin=$(login "$port" admin@example.com "$PASSWORD")

	# The user Maple's docs tell a customer to create: API-only, global Observer.
	call "$port" "$admin" POST /api/v1/fleet/users/admin "$(jq -cn --arg p "$PASSWORD" \
		'{name:"Maple",email:"maple@example.com",password:$p,global_role:"observer",api_only:true,admin_forced_password_reset:false}')"
	local observer
	observer=$(echo "$BODY" | jq -r '.token // empty')
	[ -n "$observer" ] || observer=$(login "$port" maple@example.com "$PASSWORD")

	call "$port" "$admin" GET /api/v1/fleet/version
	ok "reading the version"
	local version major minor
	version=$(echo "$BODY" | jq -r .version)
	major=${version%%.*}
	minor=${version#*.}
	minor=${minor%%.*}
	# Where this version keeps fleets and policies, as the API changed in 4.82 and in 5.0.
	local groups=/fleets key=fleet_id
	if [ "$major" -lt 5 ]; then key=team_id; fi
	if [ "$major" -lt 5 ] && [ "$minor" -lt 82 ]; then groups=/teams; fi
	# Devices in no fleet have policies of their own from 4.57; before it fleet 0 does not exist.
	local unassigned=true
	if [ "$major" -lt 5 ] && [ "$minor" -lt 57 ]; then unassigned=false; fi

	policy() { # policy <global|fleet id> <name> <query> <critical>
		local body
		body=$(jq -cn --arg n "$2" --arg q "$3" --argjson c "$4" '{name:$n,query:$q,critical:$c,description:("Checks: " + $n),resolution:("Fix: " + $n)}')
		if [ "$major" -ge 5 ]; then
			[ "$1" = global ] || body=$(echo "$body" | jq -c --argjson f "$1" '. + {fleet_id:$f}')
			call "$port" "$admin" POST /api/v1/fleet/policies "$body"
		elif [ "$1" = global ]; then
			call "$port" "$admin" POST /api/v1/fleet/global/policies "$body"
		else
			call "$port" "$admin" POST "/api/v1/fleet$groups/$1/policies" "$body"
		fi
		ok "creating policy $2"
	}
	local fails='SELECT 1 WHERE 1 = 0;' passes='SELECT 1;'

	# Fleet Free refuses a critical policy.
	local critical=false
	[ "$tier" = premium ] && critical=true
	policy global "No compromised packages" "$fails" "$critical"
	policy global "Agent reporting" "$passes" false
	local laptops="" servers=""
	if [ "$tier" = premium ]; then
		call "$port" "$admin" POST "/api/v1/fleet$groups" '{"name":"Engineering laptops"}'
		ok "creating a fleet"
		laptops=$(echo "$BODY" | jq -r '(.fleet // .team).id')
		call "$port" "$admin" POST "/api/v1/fleet$groups" '{"name":"Build servers"}'
		ok "creating a fleet"
		servers=$(echo "$BODY" | jq -r '(.fleet // .team).id')
		policy "$laptops" "Disk encrypted" "SELECT 1 FROM system_info WHERE hostname = 'ws-ada';" true
		policy "$laptops" "Screen lock on" "$fails" false
		policy "$laptops" "OS up to date" "$passes" false
		policy "$servers" "SSH root login off" "$fails" false
		[ "$unassigned" = true ] && policy 0 "Enrolled in a fleet" "$fails" false
	fi

	call "$port" "$admin" GET /api/v1/fleet/spec/enroll_secret
	ok "reading the enroll secret"
	ENROLL_SECRET=$(echo "$BODY" | jq -r '.spec.secrets[0].secret') compose "$port" --profile devices up -d ws-ada ws-bob srv-cid stray-dee >&2

	echo "  waiting for four devices to enroll" >&2
	until call "$port" "$admin" GET /api/v1/fleet/hosts/count && [ "$(echo "$BODY" | jq -r '.count // 0')" = 4 ]; do sleep 3; done
	if [ "$tier" = premium ]; then
		call "$port" "$admin" GET "/api/v1/fleet/hosts?per_page=50"
		local hosts=$BODY
		id_of() { echo "$hosts" | jq -r --arg h "$1" '.hosts[] | select(.hostname == $h) | .id'; }
		call "$port" "$admin" POST /api/v1/fleet/hosts/transfer "{\"$key\":$laptops,\"hosts\":[$(id_of ws-ada),$(id_of ws-bob)]}"
		ok "moving devices to a fleet"
		call "$port" "$admin" POST /api/v1/fleet/hosts/transfer "{\"$key\":$servers,\"hosts\":[$(id_of srv-cid)]}"
		ok "moving devices to a fleet"
	fi

	# Counts are written by a cron job: run it until every device has answered every policy.
	local want="9 failing, 7 passing" path zero=0
	[ "$unassigned" = true ] || { want="8 failing, 7 passing"; zero=""; }
	[ "$tier" = premium ] || want="4 failing, 4 passing"
	echo "  waiting for policy counts ($want)" >&2
	while :; do
		call "$port" "$admin" POST "/api/latest/fleet/trigger?name=cleanups_then_aggregation"
		sleep 5
		local failing=0 passing=0 scope
		for scope in global $zero $laptops $servers; do
			if [ "$scope" = global ]; then
				if [ "$major" -ge 5 ]; then path=/api/v1/fleet/policies; else path=/api/v1/fleet/global/policies; fi
			elif [ "$tier" != premium ]; then
				continue
			elif [ "$major" -ge 5 ]; then
				path="/api/v1/fleet/policies?fleet_id=$scope"
			else
				path="/api/v1/fleet$groups/$scope/policies"
			fi
			call "$port" "$observer" GET "$path"
			failing=$((failing + $(echo "$BODY" | jq '[.policies[]?.failing_host_count // 0] | add // 0')))
			passing=$((passing + $(echo "$BODY" | jq '[.policies[]?.passing_host_count // 0] | add // 0')))
		done
		[ "$failing failing, $passing passing" = "$want" ] && break
	done
	jq -cn --arg url "https://localhost:$port" --arg token "$observer" --arg version "$version" --arg tier "$tier" \
		--argjson unassigned "$unassigned" \
		'{url:$url,token:$token,version:$version,tier:$tier,unassigned:$unassigned}' >"$STATE/target-$port.json"
	echo "  ready: Fleet $version" >&2
}

for spec in "$@"; do
	IFS=: read -r tag port tier <<<"$spec"
	seed "$tag" "$port" "$tier"
done

echo >&2
echo "Run the live test from packages/backend with:" >&2
echo "NODE_EXTRA_CA_CERTS=$PWD/$STATE/fleet.crt FLEET_LIVE_TARGETS='$(jq -cs . "$STATE"/target-*.json)' bunx vitest run src/services/integrations/FleetFindingsService.live.e2e.test.ts"
