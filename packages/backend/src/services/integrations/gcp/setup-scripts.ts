import { gcpConnectorResourceNames } from "@maple/domain/gcp"
import { IntegrationsPersistenceError } from "@maple/domain/http"
import type {
	GcpConnectorId,
	GcpLogFilter,
	GcpProjectId,
	GcpResourceNumber,
	GcpScopeType,
} from "@maple/domain/primitives"
import { Effect } from "effect"

/**
 * Single-quote a value for bash. Every value a script uses goes through here; the scope named in
 * its header comment is an id the API has pattern-checked.
 */
const sh = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const DOCS_URL = "https://maple.dev/docs/integrations/gcp"
const OTEL_DOCS_URL = "https://maple.dev/docs/integrations/gcp-opentelemetry"

// A connection's IDs are fixed once it exists, so a wrong one is fixed by connecting again.
const WRONG_ID =
	"If it is wrong, remove the connection in Maple and connect the right ID: a connection's ID can't be changed."

// High volume that says little about a workload. Data Access audit logs record every API read.
// Load balancer health-check probes hit each backend every few seconds. A GKE cluster renews
// its leader-election leases all day, about 570 audit entries a minute for one idle node. A VM
// writes its serial console at boot, thousands of lines of raw terminal output.
const NOISE = [
	'NOT log_id("cloudaudit.googleapis.com/data_access")',
	'NOT httpRequest.userAgent:"GoogleHC"',
	'NOT protoPayload.methodName="io.k8s.coordination.v1.leases.update"',
	'NOT logName:"serialconsole.googleapis.com"',
]

// Left out unless asked for: a workload that sends its logs to Maple over OpenTelemetry would
// have every container line stored twice, and Google's copy carries no trace link.
const GKE_CONTAINER_LOGS = 'NOT resource.type="k8s_container"'

export const gcpLogFilter = (includeGkeContainerLogs: boolean): string =>
	[...NOISE, ...(includeGkeContainerLogs ? [] : [GKE_CONTAINER_LOGS])].join(" AND ")

/** What a connector covers and where Maple's own resources live. */
export interface GcpScriptTarget {
	readonly connectorId: GcpConnectorId
	readonly scopeType: GcpScopeType
	readonly scopeId: GcpProjectId | GcpResourceNumber
	/** The host project: topic, subscription and service account are created here. */
	readonly projectId: GcpProjectId
	/** The Google Cloud integration page, where the script sends its reader back to. */
	readonly mapleUrl: string
}

// How each scope is addressed: the flag that places a log sink, the command family that reads it
// and edits its IAM policy, the role that may edit that policy, and how to look its ID up.
const SCOPES = {
	project: {
		sink: '--project="$SCOPE_ID"',
		gcloud: "gcloud projects",
		iamRole: "Owner",
		list: "gcloud projects list",
	},
	folder: {
		sink: '--folder="$SCOPE_ID"',
		gcloud: "gcloud resource-manager folders",
		iamRole: "Folder IAM Admin",
		list: "gcloud resource-manager folders list --organization=ORGANIZATION_ID",
	},
	organization: {
		sink: '--organization="$SCOPE_ID"',
		gcloud: "gcloud organizations",
		iamRole: "Organization Administrator",
		list: "gcloud organizations list",
	},
} as const

// A project is its own host project, so its script says "the project".
const hostProject = (scopeType: GcpScopeType): string =>
	scopeType === "project" ? "the project" : "the host project"

// A folder or organization sink also routes the logs of every project underneath.
const includeChildren = (scopeType: GcpScopeType): string =>
	scopeType === "project" ? "" : " --include-children"

const variables = (target: GcpScriptTarget, more: ReadonlyArray<string>): string => {
	const names = gcpConnectorResourceNames(target.connectorId)
	return `
# ---- This connection ----
# PROJECT_ID ${target.scopeType === "project" ? "" : "is the host project: it "}holds Maple's Pub/Sub topic, subscription and service account.
PROJECT_ID=${sh(target.projectId)}
SCOPE_ID=${sh(target.scopeId)}
TOPIC=${sh(names.topic)}
SUBSCRIPTION=${sh(names.subscription)}
SINK=${sh(names.sink)}
SERVICE_ACCOUNT=${sh(names.serviceAccountId)}
SERVICE_ACCOUNT_EMAIL="$SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com"
${more.map((line) => `${line}\n`).join("")}MAPLE_URL=${sh(target.mapleUrl)}
SCOPE="${target.scopeType} $SCOPE_ID"
OWNER="Owner on project $PROJECT_ID"
SINK_ROLE="Logs Configuration Writer on $SCOPE"
IAM_ROLE="${SCOPES[target.scopeType].iamRole} on $SCOPE"
`
}

// Google's own output is shown only for a step that fails, under what failed and above what to
// do about it. `stop` ends the script: every step can be run again, so nothing is rolled back.
const output = (unfinished: string) => `
# ---- What this script prints ----
# Its marks are spelled as bytes: the text you paste is plain ASCII, which every terminal and
# locale passes on unchanged.
section() { printf '\\n%s\\n' "$1"; }
ok() { printf '  \\342\\234\\223 %s\\n' "$1"; }

# stop <what went wrong> <what to do> [Google's answer]
stop() {
  printf '  \\342\\234\\227 %s\\n' "$1"
  # Google can quote the push endpoint back, and this output may be sent to support. The error
  # line says what was refused; the machine-readable details that follow it are left out.
  if [ -n "\${3-}" ]; then
    printf '\\n'
    printf '%s\\n' "$3" | sed -e "/^- '@type':/,\\$d" -e 's/secret=[^ )&"]*/secret=HIDDEN/g' -e 's/^/      /'
  fi
  printf '\\n    What to do: %s\\n' "$2"
  printf '\\n%s\\n' ${sh(unfinished)}
  exit 1
}

# fix <Google's answer> <role that allows the step>: what to do about a refused step.
fix() {
  case "$1" in
    *"requires billing"* | *BILLING_DISABLED* | *"Billing must be enabled"* | *BILLING_NOT_FOUND*)
      printf '%s' "Project $PROJECT_ID has no active billing account. Link one at https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID" ;;
    *allowedPolicyMember* | *"permitted customer"*)
      printf '%s' "An organization policy (domain restricted sharing) blocks this grant. Ask an Organization Policy Administrator to lift it for project $PROJECT_ID while this script runs. See ${DOCS_URL}#domain-restricted-sharing" ;;
    # Google words these two as a denial too, so they are read before the missing role.
    *"has not been used"* | *"is disabled"* | *SERVICE_DISABLED*)
      printf '%s' "Google is still switching an API on, or the API is off. Wait a minute and paste the script again." ;;
    *"ervice account"*"does not exist"* | *"Unknown service account"*)
      printf '%s' "Google has not published the new service account yet. Wait a minute and paste the script again." ;;
    # Pub/Sub words a refusal as "User not authorized to perform this action".
    *PERMISSION_DENIED* | *"does not have permission"* | *"denied on resource"* | *"not authorized"*)
      printf '%s' "$ACCOUNT needs $2." ;;
    *"Unparseable filter"*)
      printf '%s' "Google does not accept the log filter. Correct the filter near the top of the script and paste it again. Filter syntax: https://cloud.google.com/logging/docs/view/logging-query-language" ;;
    *) printf '%s' "Read Google's answer above. If it is unclear, send this output to support@maple.dev." ;;
  esac
}

# try <line when it failed> <role that allows it> <command...>
try() {
  local failed="$1" role="$2" output
  shift 2
  output="$("$@" 2>&1)" || stop "$failed" "$(fix "$output" "$role")" "$output"
}

# run <line when it worked> <line when it failed> <role that allows it> <command...>
run() {
  local worked="$1"
  shift
  try "$@"
  ok "$worked"
}

# report <what was applied, as JSON members>: the message that tells Maple what a run did. It has
# the form of a log entry; Maple reads it and does not store it.
report() {
  printf '{"logName":"projects/%s/logs/maple-setup","timestamp":"%s","jsonPayload":{%s}}' \\
    "$PROJECT_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}
`

const POST_REPORT = `curl -fsS --max-time 15 -o /dev/null -X POST -H 'Content-Type: application/json'`

// Through the topic while there is one: the message arriving proves topic, subscription and
// Maple are wired up. Maple not hearing of a run must never fail it.
const notify = (throughTopic: boolean) => `
# notify <line when it worked> <what was applied, as JSON members>
CONFIRMED=1
notify() {
  if ${
		throughTopic
			? `gcloud pubsub topics publish "$TOPIC" --project="$PROJECT_ID" --message="$(report "$2")"`
			: `${POST_REPORT} --data "$(report "$2")" "$PUSH_ENDPOINT"`
  } >/dev/null 2>&1; then
    ok "$1"
  elif [ "$CONFIRMED" = 1 ]; then
    printf "  \\342\\200\\242 Couldn't reach Maple to confirm. Maple shows the connection as pending until a later run reaches it.\\n"
    CONFIRMED=0
  fi
}
`

// Removal must not take "could not look" for "not there": a sink the caller may not see would
// otherwise be left routing into a topic the next step deletes.
const REMOVAL_HELPERS = `
# remains <what it is> <role that may look> <gcloud ... describe ...>: whether a resource is still
# there. NOT_FOUND means it is not, and so does a disabled API for the topic, the subscription
# and the service account: setup switches their APIs on before it creates them (a sink can exist
# without). Any other answer stops the script: the resource may still be there, and nothing that
# it depends on is removed before it.
remains() {
  local what="$1" role="$2" output
  shift 2
  if output="$("$@" 2>&1)"; then return 0; fi
  case "$2:$output" in
    *NOT_FOUND*) return 1 ;;
    logging:*) ;;
    *"has not been used"* | *"is disabled"*) return 1 ;;
  esac
  stop "Couldn't check whether $what still exists." "$(fix "$output" "$role")" "$output"
}

# unbind <role that allows it> <gcloud ... remove-iam-policy-binding ...>: a binding that is
# already gone is fine.
unbind() {
  local role="$1" output
  shift
  if output="$("$@" 2>&1)"; then return 0; fi
  case "$output" in *"Policy binding"*"not found"*) return 0 ;; esac
  stop "Couldn't remove the read-only roles." "$(fix "$output" "$role")" "$output"
}
`

// APIs in the host project. Cloud Resource Manager is what gcloud reads projects and grants
// roles through.
const LOG_APIS = ["pubsub.googleapis.com", "logging.googleapis.com", "cloudresourcemanager.googleapis.com"]
const METRIC_APIS = [
	"monitoring.googleapis.com",
	"cloudasset.googleapis.com",
	"iam.googleapis.com",
	"iamcredentials.googleapis.com",
	"cloudresourcemanager.googleapis.com",
]

// Signed in as a person in Cloud Shell, gcloud's calls are counted against Google's own project,
// which has the Cloud Resource Manager API. With it off for a service account, every describe
// and role grant fails.
const apisOff = (
	scopeType: GcpScopeType,
	apis: ReadonlyArray<string>,
) => `# Which of the APIs this script needs are off in ${hostProject(scopeType)}, asked once.
APIS_OFF="$(off ${apis.join(" ")})"
# gcloud needs the Cloud Resource Manager API of the project its calls are counted against. For a
# service account that is its own project, usually this one, so it is switched on before the
# first read. Not everyone may switch an API on: a refusal here is reported further down.
case "$APIS_OFF" in *cloudresourcemanager*)
  if gcloud services enable cloudresourcemanager.googleapis.com --project="$PROJECT_ID" >/dev/null 2>&1; then
    APIS_OFF="\${APIS_OFF/ cloudresourcemanager.googleapis.com/}"
  fi ;;
esac
`

const sinkAndFilter = (sink: string) => `
# A filter Google would refuse is found here, before the topic and subscription exist: reading
# one entry makes Google parse it. Not being allowed to read logs is not an error.
SINK_EXISTS=0
if exists gcloud logging sinks describe "$SINK" ${sink}; then SINK_EXISTS=1; fi
if [ "$SINK_EXISTS" = 0 ] || [ "$LOG_FILTER_MODE" = set ]; then
  if FILTER_ANSWER="$(gcloud logging read "$LOG_FILTER" --limit=1 --freshness=1h ${sink} 2>&1 >/dev/null)"; then
    ok "Log filter accepted"
  else
    case "$FILTER_ANSWER" in *"Unparseable filter"*)
      stop "Google does not accept the log filter." "$(fix "$FILTER_ANSWER" "")" "$FILTER_ANSWER" ;;
    esac
  fi
fi
`

interface AccessChecks {
	/** Setup only: the APIs the enabled sections need in the host project. */
	readonly apis: ReadonlyArray<string>
	/** Setup with log forwarding on: the flag that places the sink. */
	readonly sink: string | undefined
	/** The scope's name must be readable: true when a role the run needs includes reading it. */
	readonly scopeMustOpen: boolean
	readonly billing: boolean
	/** `testIamPermissions` calls: resource path, where in words, what to ask for, permissions. */
	readonly permissions: ReadonlyArray<readonly [string, string, string, ReadonlyArray<string>]>
}

const openScope = (scopeType: Exclude<GcpScopeType, "project">, mustOpen: boolean): string => {
	const scope = SCOPES[scopeType]
	const describe = `${scope.gcloud} describe "$SCOPE_ID"`
	const label = scopeType === "folder" ? "Folder" : "Organization"
	return mustOpen
		? `if ! SCOPE_NAME="$(${describe} --format='value(displayName)' 2>/dev/null)"; then
  stop "Can't open $SCOPE as $ACCOUNT." "Check the ID with: ${scope.list}. ${WRONG_ID} If it is right, this account needs ${scope.iamRole} there." "$(${describe} 2>&1 || true)"
fi
ok "${label} $SCOPE_ID found ($SCOPE_NAME)"
`
		: `# Not every role that can do this work may read the ${scopeType}'s name (Logs Configuration
# Writer may not), so a look that fails is not an error.
if SCOPE_NAME="$(${describe} --format='value(displayName)' 2>/dev/null)"; then
  ok "${label} $SCOPE_ID found ($SCOPE_NAME)"
fi
`
}

const PERMISSION_CHECK = `
# allowed <resource> <where, in words> <what to ask for> <permission...>: asks Google which of
# the permissions this account holds, before anything is changed. No answer (no curl, no network)
# is not a refusal: the steps below then report for themselves.
CHECKED=1
allowed() {
  local resource="$1" where="$2" ask="$3" answer permission lacking="" held=0
  shift 3
  if ! answer="$(curl -fsS --max-time 15 -X POST -H 'Content-Type: application/json' \\
    -H @<(printf 'Authorization: Bearer %s\\n' "$TOKEN") \\
    --data "{\\"permissions\\":[$(printf '"%s",' "$@" | sed 's/,$//')]}" \\
    "https://cloudresourcemanager.googleapis.com/v3/$resource:testIamPermissions" 2>/dev/null)"; then
    CHECKED=0
    return 0
  fi
  for permission in "$@"; do
    case "$answer" in *"\\"$permission\\""*) held=1 ;; *) lacking="$lacking, $permission" ;; esac
  done
  if [ -z "$lacking" ]; then return 0; fi
  # None of several held: a wrong ID is likelier than a list of missing rights.
  if [ "$held" = 0 ] && [ "$#" -gt 1 ]; then
    stop "$ACCOUNT has none of the permissions this script needs on $where." "Check the ID in Maple. ${WRONG_ID} If it is right, this account has no rights there. $ask"
  fi
  stop "$ACCOUNT is missing permissions on $where: \${lacking#, }." "$ask"
}
`

const access = (scopeType: GcpScopeType, checks: AccessChecks): string => `
# ---- Checking access: nothing is created or removed before all of it passes ----
section "Checking access"
command -v gcloud >/dev/null 2>&1 ||
  stop "gcloud is not installed here." "Run this script in Cloud Shell: https://shell.cloud.google.com"
ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
TOKEN="$(gcloud auth print-access-token 2>/dev/null || true)"
if [ -z "$ACCOUNT" ] || [ -z "$TOKEN" ]; then
  stop "You are not signed in to Google Cloud." "In Cloud Shell, click Authorize when it asks. Elsewhere, run: gcloud auth login"
fi
ok "Signed in as $ACCOUNT"
${checks.apis.length === 0 ? "" : apisOff(scopeType, checks.apis)}${scopeType === "project" ? "" : openScope(scopeType, checks.scopeMustOpen)}if ! PROJECT_NAME="$(gcloud projects describe "$PROJECT_ID" --format='value(name)' 2>/dev/null)"; then
  stop "Can't open project $PROJECT_ID as $ACCOUNT." "Check the ID in Maple (it is the project ID, not the name or number; list yours with: gcloud projects list). ${WRONG_ID} If it is right, this account has no access to the project." "$(gcloud projects describe "$PROJECT_ID" 2>&1 || true)"
fi
ok "${scopeType === "project" ? "Project" : "Host project"} $PROJECT_ID found ($PROJECT_NAME)"
${
	checks.billing
		? `case "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || true)" in
  True) ok "Billing is enabled" ;;
  False) stop "Project $PROJECT_ID has no billing account." "Cloud Monitoring only answers for projects with billing. Link one at https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID" ;;
esac
`
		: ""
}${
	checks.permissions.length === 0
		? ""
		: `${PERMISSION_CHECK}${checks.permissions
				.map(
					([resource, where, ask, permissions]) =>
						`allowed "${resource}" "${where}" "${ask}" \\\n  ${permissions.join(" ")}\n`,
				)
				.join("")}# Switching an API on takes a right of its own, asked about only when one is off.
[ -z "$APIS_OFF" ] || allowed "projects/$PROJECT_ID" "project $PROJECT_ID" "This script has to switch on:$APIS_OFF. Ask for Service Usage Admin there, or have an administrator switch them on." \\
  serviceusage.services.enable
[ "$CHECKED" = 0 ] || ok "$ACCOUNT has the permissions this script needs"
`
}${checks.sink === undefined ? "" : sinkAndFilter(checks.sink)}`

/** What the enabled sections need, asked of Google before the first change. */
const permissionChecks = (
	scopeType: GcpScopeType,
	logs: boolean,
	metrics: boolean,
): AccessChecks["permissions"] => {
	if (!logs && !metrics) return []
	const scope = SCOPES[scopeType]
	const administrator = "or have an administrator run this script."
	const host = [
		"resourcemanager.projects.getIamPolicy",
		"resourcemanager.projects.setIamPolicy",
		...(logs
			? [
					"pubsub.topics.create",
					"pubsub.topics.attachSubscription",
					"pubsub.topics.setIamPolicy",
					"pubsub.topics.publish",
					"pubsub.subscriptions.create",
					"pubsub.subscriptions.update",
				]
			: []),
		...(metrics ? ["iam.serviceAccounts.create", "iam.serviceAccounts.setIamPolicy"] : []),
	]
	const sink = logs ? ["logging.sinks.create", "logging.sinks.update"] : []
	const askHost = `Ask for Owner there, ${administrator}`
	if (scopeType === "project") {
		return [["projects/$PROJECT_ID", "project $PROJECT_ID", askHost, [...host, ...sink]]]
	}
	const roles = [...(logs ? ["Logs Configuration Writer"] : []), ...(metrics ? [scope.iamRole] : [])]
	return [
		["projects/$PROJECT_ID", "project $PROJECT_ID", askHost, host],
		[
			`${scopeType}s/$SCOPE_ID`,
			"$SCOPE",
			`Ask for ${roles.join(" and ")} there, ${administrator} If the ID looks wrong, check it with: ${scope.list}`,
			[...sink, ...(metrics ? [`resourcemanager.${scopeType}s.setIamPolicy`] : [])],
		],
	]
}

const logsSetup = (scopeType: GcpScopeType): string => `
# ---- Log forwarding: on ----
section "Log forwarding"
DESTINATION="pubsub.googleapis.com/projects/$PROJECT_ID/topics/$TOPIC"

# APIs in ${hostProject(scopeType)}: Pub/Sub carries the log entries, Cloud Logging routes them,
# and Cloud Resource Manager is what gcloud grants the roles below through.
apis "Pub/Sub, Cloud Logging, Cloud Resource Manager" ${LOG_APIS.join(" ")}

if exists gcloud pubsub topics describe "$TOPIC" --project="$PROJECT_ID"; then
  ok "Topic already exists"
else
  run "Topic created" "Couldn't create the Pub/Sub topic." "$OWNER" \\
    gcloud pubsub topics create "$TOPIC" --project="$PROJECT_ID"
fi

# One LogEntry per request, unwrapped. A day of retention bounds what is replayed after an
# outage, and the subscription never expires while it is idle.
SUBSCRIPTION_FLAGS=(
  --project="$PROJECT_ID"
  --push-endpoint="$PUSH_ENDPOINT" --push-no-wrapper
  --ack-deadline=30 --message-retention-duration=1d --expiration-period=never
  --min-retry-delay=10s --max-retry-delay=600s
)
if exists gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT_ID"; then
  run "Push subscription up to date" "Couldn't update the push subscription." "$OWNER" \\
    gcloud pubsub subscriptions update "$SUBSCRIPTION" "\${SUBSCRIPTION_FLAGS[@]}"
else
  run "Push subscription created" "Couldn't create the push subscription." "$OWNER" \\
    gcloud pubsub subscriptions create "$SUBSCRIPTION" --topic="$TOPIC" "\${SUBSCRIPTION_FLAGS[@]}"
fi

if [ "$SINK_EXISTS" = 1 ]; then
  if [ "$LOG_FILTER_MODE" = set ]; then
    run "Log sink up to date (filter replaced)" "Couldn't update the log sink." "$SINK_ROLE" \\
      gcloud logging sinks update "$SINK" "$DESTINATION" --log-filter="$LOG_FILTER" ${SCOPES[scopeType].sink}${includeChildren(scopeType)}
    FILTER_REPLACED=1
  else
    run "Log sink up to date (filter kept)" "Couldn't update the log sink." "$SINK_ROLE" \\
      gcloud logging sinks update "$SINK" "$DESTINATION" ${SCOPES[scopeType].sink}${includeChildren(scopeType)}
  fi
else
  run "Log sink created" "Couldn't create the log sink." "$SINK_ROLE" \\
    gcloud logging sinks create "$SINK" "$DESTINATION" --log-filter="$LOG_FILTER" ${SCOPES[scopeType].sink}${includeChildren(scopeType)}
  SINK_CREATED=1
fi

# The sink writes as a Google-managed identity. Google requires Logs Writer for it on the project
# that holds the destination, and it needs Pub/Sub Publisher on this one topic.
if ! WRITER_IDENTITY="$(gcloud logging sinks describe "$SINK" ${SCOPES[scopeType].sink} --format='value(writerIdentity)' 2>/dev/null)"; then
  WRITER_IDENTITY="$(gcloud logging sinks describe "$SINK" ${SCOPES[scopeType].sink} 2>&1 || true)"
  stop "Couldn't read the log sink back." "$(fix "$WRITER_IDENTITY" "$SINK_ROLE")" "$WRITER_IDENTITY"
fi
run "Sink allowed to write to the project" "Couldn't grant the sink Logs Writer." "$OWNER" \\
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \\
  --member="$WRITER_IDENTITY" --role=roles/logging.logWriter --condition=None
run "Sink allowed to publish to the topic" "Couldn't grant the sink Pub/Sub Publisher." "$OWNER" \\
  gcloud pubsub topics add-iam-policy-binding "$TOPIC" --project="$PROJECT_ID" \\
  --member="$WRITER_IDENTITY" --role=roles/pubsub.publisher
notify "Check message sent to Maple through the topic" '"logs":true'
`

const logsRemoval = (scopeType: GcpScopeType, notifies: boolean): string => `
# ---- Log forwarding: off. Remove what an earlier run created. ----
# The sink goes first, so nothing routes into a topic that is gone. Google keeps routing for a
# while after a sink is deleted, and with the topic gone by then it logs an error in this project
# and may notify its contacts, so the topic waits a minute. The Logs Writer grant on
# ${hostProject(scopeType)} stays: the sink wrote as the logging service agent of the ${scopeType},
# an identity every other sink there shares.
section "Log forwarding"
if remains "the log sink" "$SINK_ROLE" gcloud logging sinks describe "$SINK" ${SCOPES[scopeType].sink}; then
  run "Log sink deleted" "Couldn't delete the log sink." "$SINK_ROLE" \\
    gcloud logging sinks delete "$SINK" ${SCOPES[scopeType].sink} --quiet
  REMOVED=1
  printf '  \\342\\200\\246 waiting a minute for Google to stop routing to the topic\\n'
  sleep 60
fi
if remains "the push subscription" "$OWNER" gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT_ID"; then
  run "Push subscription deleted" "Couldn't delete the push subscription." "$OWNER" \\
    gcloud pubsub subscriptions delete "$SUBSCRIPTION" --project="$PROJECT_ID" --quiet
  REMOVED=1
fi
if remains "the topic" "$OWNER" gcloud pubsub topics describe "$TOPIC" --project="$PROJECT_ID"; then
  run "Topic deleted" "Couldn't delete the Pub/Sub topic." "$OWNER" \\
    gcloud pubsub topics delete "$TOPIC" --project="$PROJECT_ID" --quiet
  REMOVED=1
fi
[ "$REMOVED" = 1 ] || ok "Nothing left to remove"
${notifies ? `notify "Maple notified" '"logs":false'\n` : ""}`

const serviceAccountMember = '--member="serviceAccount:$SERVICE_ACCOUNT_EMAIL"'

const metricsSetup = (scopeType: GcpScopeType): string => `
# ---- Metrics and resources: on ----
section "Metrics and resources"

# APIs in ${scopeType === "project" ? "the project" : "the host project, the project Maple's reads are made through"}:
#   monitoring.googleapis.com      Cloud Monitoring, to read metrics
#   cloudasset.googleapis.com      Cloud Asset Inventory, to list resources
#   iam.googleapis.com             to create the service account below
#   iamcredentials.googleapis.com  short-lived tokens for that account; no key is ever created
#   cloudresourcemanager.googleapis.com  what gcloud grants the roles below through
apis "Cloud Monitoring, Cloud Asset, IAM, IAM Credentials, Cloud Resource Manager" \\
  ${METRIC_APIS.join(" ")}

# A service account that an earlier run deleted (metrics switched off) fails this describe as
# well and is created again. Google makes that a new account under the same name, with none of
# the old one's roles, so every grant below is made for it.
if exists gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID"; then
  ok "Read-only service account already exists"
else
  run "Read-only service account created" "Couldn't create the service account." "$OWNER" \\
    gcloud iam service-accounts create "$SERVICE_ACCOUNT" --project="$PROJECT_ID" \\
    --display-name="Maple metrics and resource reader"
  ACCOUNT_CREATED=1
fi

# grant <line when it failed> <role that allows it> <gcloud ... add-iam-policy-binding ...>
# Google can take a minute to publish a new service account, and until then answers that it does
# not exist. Only that answer is waited out, for a minute at most.
WAITED=0
grant() {
  local failed="$1" role="$2" output tries=0
  shift 2
  while ! output="$("$@" 2>&1)"; do
    tries=$((tries + 1))
    case "$output" in *"does not exist"* | *NOT_FOUND*) ;; *) tries=20 ;; esac
    if [ "$tries" -ge 20 ]; then stop "$failed" "$(fix "$output" "$role")" "$output"; fi
    if [ "$WAITED" = 0 ]; then
      printf '  \\342\\200\\246 waiting for Google to publish the new service account\\n'
      WAITED=1
    fi
    sleep 3
  done
}

# Read-only roles on the ${scopeType}${scopeType === "project" ? "" : ", inherited by every project under it"}:
#   roles/monitoring.viewer  read metrics (monitoring.timeSeries.list)
#   roles/cloudasset.viewer  list resources (cloudasset.assets.searchAllResources)
# These are the narrowest predefined roles for the two calls. Both are read-only, and broader
# than the calls: Cloud Asset Viewer can also read resource metadata and IAM policies.
for ROLE in roles/monitoring.viewer roles/cloudasset.viewer; do
  grant "Couldn't grant the read-only roles." "$IAM_ROLE" \\
    ${SCOPES[scopeType].gcloud} add-iam-policy-binding "$SCOPE_ID" \\
    ${serviceAccountMember} --role="$ROLE" --condition=None
done
# Cloud Asset Inventory checks serviceusage.services.use on the project its API is called through.
grant "Couldn't grant the read-only roles." "$OWNER" \\
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \\
  ${serviceAccountMember} --role=roles/serviceusage.serviceUsageConsumer --condition=None
ok "Read-only roles granted (Monitoring Viewer, Cloud Asset Viewer, Service Usage Consumer)"

# Maple's own account may mint short-lived tokens for this one service account, nothing else.
grant "Couldn't let Maple use the service account." "$OWNER" \\
  gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" \\
  --member="serviceAccount:$MAPLE_SERVICE_ACCOUNT" --role=roles/iam.serviceAccountTokenCreator \\
  --condition=None
ok "Maple allowed to read as that account"
notify "Maple notified" '"metrics":true'
`

const metricsRemoval = (scopeType: GcpScopeType, notifies: boolean): string => `
# ---- Metrics and resources: off. Remove what an earlier run created. ----
section "Metrics and resources"
# Looked up in the list: for 30 days after a service account is deleted, describing it answers
# PERMISSION_DENIED even to an Owner, which would read as "may still be there" on every re-run.
# A list that fails is read like a failed describe.
account_remains() {
  local output
  if output="$("$@" 2>/dev/null)"; then
    [ -n "$output" ]
    return
  fi
  output="$("$@" 2>&1 || true)"
  case "$output" in *"has not been used"* | *"is disabled"*) return 1 ;; esac
  stop "Couldn't check whether the read-only service account still exists." "$(fix "$output" "$OWNER")" "$output"
}
if account_remains gcloud iam service-accounts list --project="$PROJECT_ID" \\
  --filter="email=$SERVICE_ACCOUNT_EMAIL" --format='value(email)'; then
  # Role bindings first: once the account is deleted they can no longer be removed by name.
  for ROLE in roles/monitoring.viewer roles/cloudasset.viewer; do
    unbind "$IAM_ROLE" ${SCOPES[scopeType].gcloud} remove-iam-policy-binding "$SCOPE_ID" \\
      ${serviceAccountMember} --role="$ROLE" --condition=None
  done
  unbind "$OWNER" gcloud projects remove-iam-policy-binding "$PROJECT_ID" \\
    ${serviceAccountMember} --role=roles/serviceusage.serviceUsageConsumer --condition=None
  ok "Read-only roles removed"
  run "Read-only service account deleted" "Couldn't delete the service account." "$OWNER" \\
    gcloud iam service-accounts delete "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" --quiet
  REMOVED=1
else
  ok "Nothing left to remove"
fi
${notifies ? `notify "Maple notified" '"metrics":false'\n` : ""}`

/**
 * The text that is copied: the script as a here-document for a child bash. Pasted at a prompt,
 * nothing runs before the closing brace is read, a failing step ends the child and not the login
 * shell, and the terminal stays the script's stdin. The first line drops the paste from the
 * history of bash 5; its leading space does the same under `HISTCONTROL=ignorespace`. Nothing
 * outside the here-document may be a comment: an interactive zsh runs `#` as a command.
 */
const forPaste = (marker: string, body: string): Effect.Effect<string, IntegrationsPersistenceError> =>
	body.split("\n").includes(marker)
		? Effect.fail(
				new IntegrationsPersistenceError({
					message: "A Google Cloud script value would end the script's here-document",
				}),
			)
		: Effect.succeed(
				` { [ -z "\${BASH_VERSION-}" ] || case "$(history 1)" in *${marker}*) history -d -1 ;; esac 2>/dev/null
bash /dev/fd/3 3<<'${marker}'
${body}${marker}
}
`,
			)

export interface GcpSetupScriptInput extends GcpScriptTarget {
	/** The ingest gateway's receiver URL for this connector, including its secret. */
	readonly pushEndpoint: string
	/** Maple's own Google service account. Undefined: the metrics setup is left untouched. */
	readonly mapleServiceAccountEmail: string | undefined
	readonly logsEnabled: boolean
	readonly metricsEnabled: boolean
	readonly logFilter: GcpLogFilter
}

/**
 * The script an administrator pastes into Cloud Shell. Logs: a Log Router sink on the scope into
 * a Pub/Sub topic whose push subscription delivers each LogEntry to Maple. Metrics and resources:
 * a read-only service account Maple may impersonate. The script converges: what the connector has
 * enabled is created or updated, what it has not is removed, so a re-run applies an opt-out. Each
 * section ends by telling Maple what it applied.
 */
export const renderGcpSetupScript = (input: GcpSetupScriptInput) => {
	const { scopeType, logsEnabled: logs } = input
	// On for the connector while this deployment has lost its Google identity: nothing is set up
	// and, above all, nothing a customer set up earlier is removed.
	const metrics = !input.metricsEnabled
		? "off"
		: input.mapleServiceAccountEmail === undefined
			? "lost"
			: "on"
	const state = (on: boolean) => (on ? "on" : "off, removing")
	const metricsState =
		metrics === "lost" ? "not available on this Maple deployment, left as is" : state(metrics === "on")
	return forPaste(
		"MAPLE_SETUP_SCRIPT",
		`#!/usr/bin/env bash
# Maple setup for Google Cloud ${scopeType} ${input.scopeId}
#   Log forwarding:        ${logs ? "on" : "off"}
#   Metrics and resources: ${metrics === "lost" ? metricsState : metrics}
# Safe to run again: it sets up what is on and removes what is off.
# Keep it private: PUSH_ENDPOINT contains this connection's secret.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
${
	logs
		? `
# ---- Which logs are forwarded ----
# LOG_FILTER leaves out what is high volume and says little about a workload: Data Access audit
# logs, load balancer health checks, Kubernetes lease renewals and VM serial console output.
${
	input.logFilter === "include_gke_container_logs"
		? `# GKE container logs are included, as chosen in Maple. Logs from workloads that also send them
# over OpenTelemetry are then stored twice: ${OTEL_DOCS_URL}`
		: `# It also leaves out GKE container logs: logs from workloads that also send them over
# OpenTelemetry would be stored twice. To include them, choose "Recommended + GKE container logs" under
# Log filter in Maple, or delete AND ${GKE_CONTAINER_LOGS} from LOG_FILTER and make
# LOG_FILTER_MODE 'set'. Details: ${OTEL_DOCS_URL}`
}
# LOG_FILTER_MODE keep: an existing sink keeps its filter, a new sink gets LOG_FILTER.
# LOG_FILTER_MODE set:  LOG_FILTER replaces the sink's filter.
# Filter syntax: https://cloud.google.com/logging/docs/view/logging-query-language
LOG_FILTER_MODE=${sh(input.logFilter === "keep" ? "keep" : "set")}
LOG_FILTER=${sh(gcpLogFilter(input.logFilter === "include_gke_container_logs"))}
`
		: ""
}${variables(input, [
			`PUSH_ENDPOINT=${sh(input.pushEndpoint)}`,
			...(input.mapleServiceAccountEmail === undefined || metrics !== "on"
				? []
				: [`MAPLE_SERVICE_ACCOUNT=${sh(input.mapleServiceAccountEmail)}`]),
		])}SINK_CREATED=0
FILTER_REPLACED=0
ACCOUNT_CREATED=0
REMOVED=0
${output("Setup did not finish. Nothing needs undoing: fix this and paste the script again.")}${notify(logs)}
# exists <gcloud ... describe ...>: a look that fails for any reason falls through to the create,
# which reports for itself.
exists() { "$@" >/dev/null 2>&1; }

# off <api...>: the APIs of the list that are not switched on in ${hostProject(scopeType)}. All of
# them when the list of enabled APIs cannot be read. Asking first lets someone who may not switch
# APIs on run a script whose APIs are on already.
off() {
  local on api nl=$'\\n'
  on="$(gcloud services list --enabled --project="$PROJECT_ID" --format='value(config.name)' 2>/dev/null || true)"
  for api in "$@"; do
    case "$nl$on$nl" in *"$nl$api$nl"*) ;; *) printf ' %s' "$api" ;; esac
  done
}

# apis <their names> <api...>: switches on the ones the access check found off.
apis() {
  local names="$1" api missing=""
  shift
  for api in "$@"; do
    case " $APIS_OFF " in *" $api "*) missing="$missing $api" ;; esac
  done
  if [ -n "$missing" ]; then
    # Unquoted on purpose: one argument per API.
    try "Couldn't switch on:$missing." "Service Usage Admin on project $PROJECT_ID" \\
      gcloud services enable $missing --project="$PROJECT_ID"
  fi
  ok "APIs enabled ($names)"
}
${logs && metrics === "on" ? "" : REMOVAL_HELPERS}
printf 'Maple setup for %s\\n' "$SCOPE"
printf '  Log forwarding          %s\\n  Metrics and resources   %s\\n' ${sh(state(logs))} ${sh(metricsState)}
${access(scopeType, {
	apis: [...new Set([...(logs ? LOG_APIS : []), ...(metrics === "on" ? METRIC_APIS : [])])],
	sink: logs ? SCOPES[scopeType].sink : undefined,
	scopeMustOpen: metrics === "on",
	billing: metrics === "on",
	permissions: permissionChecks(scopeType, logs, metrics === "on"),
})}${logs ? logsSetup(scopeType) : logsRemoval(scopeType, true)}${
			metrics === "on"
				? metricsSetup(scopeType)
				: metrics === "off"
					? metricsRemoval(scopeType, true)
					: ""
		}
if [ "$SINK_CREATED$ACCOUNT_CREATED$REMOVED$FILTER_REPLACED" = 0000 ]; then
  printf '\\nDone. Everything is in place.\\n'
elif [ "$SINK_CREATED$ACCOUNT_CREATED$REMOVED" = 000 ]; then
  printf '\\nDone. The log sink has the filter of this script. Everything else is in place.\\n'
elif [ "$REMOVED" = 1 ]; then
  printf '\\nDone. Google Cloud matches your Maple switches.\\n'
else
  printf '\\nDone. Google Cloud is set up for Maple.\\n'
fi
if [ "$CONFIRMED" = 1 ]; then printf '  Maple confirms it within a minute: %s\\n' "$MAPLE_URL"; fi
if [ "$SINK_CREATED" = 1 ]; then
  printf '  Logs:    a new sink can take about 10 minutes to start forwarding. What is logged before\\n'
  printf '           it does is not forwarded later.\\n'
fi
if [ "$ACCOUNT_CREATED" = 1 ]; then printf '  Metrics: the first read lands within about 10 minutes.\\n'; fi
`,
	)
}

export interface GcpCleanupScriptInput extends GcpScriptTarget {
	/** Set while the connector exists: the script then tells Maple that it ran. */
	readonly pushEndpoint: string | undefined
}

/** Removes what the setup script created. Without a push endpoint it carries no secret. */
export const renderGcpCleanupScript = (input: GcpCleanupScriptInput) =>
	forPaste(
		"MAPLE_CLEANUP_SCRIPT",
		`#!/usr/bin/env bash
# Maple cleanup for Google Cloud ${input.scopeType} ${input.scopeId}
# Removes what the Maple setup script created. The APIs it switched on stay on.
# Safe to run again.${input.pushEndpoint === undefined ? "" : "\n# Keep it private: PUSH_ENDPOINT contains this connection's secret."}
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
${variables(input, input.pushEndpoint === undefined ? [] : [`PUSH_ENDPOINT=${sh(input.pushEndpoint)}`])}REMOVED=0
${output(
	"Cleanup did not finish. Fix this and paste the script again: it continues where it stopped.",
)}${REMOVAL_HELPERS}
printf 'Maple cleanup for %s\\n' "$SCOPE"
${access(input.scopeType, { apis: [], sink: undefined, scopeMustOpen: false, billing: false, permissions: [] })}${logsRemoval(input.scopeType, false)}${metricsRemoval(input.scopeType, false)}${
			input.pushEndpoint === undefined
				? ""
				: `
# Tells Maple the cleanup ran. Maple refuses this once the connection is deleted, which is fine.
${POST_REPORT} --data "$(report '"logs":false,"metrics":false')" "$PUSH_ENDPOINT" >/dev/null 2>&1 || true
`
		}
printf '\\nDone. Everything the setup script created is gone.\\n'
printf '  Left in place: the APIs it switched on, and the Logs Writer role of Google'"'"'s logging\\n'
printf '  service account on %s, which other sinks share.\\n' "$PROJECT_ID"
${input.pushEndpoint === undefined ? "" : `printf '  Now disconnect in Maple: %s\\n' "$MAPLE_URL"\n`}`,
	)
