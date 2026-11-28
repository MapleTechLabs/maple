import {
	GCP_LOG_APIS,
	GCP_METRIC_APIS,
	GCP_READER_PROJECT_ROLE,
	GCP_READER_SCOPE_ROLES,
	GCP_SECURITY_APIS,
	GCP_SECURITY_NOTIFICATION_FILTER,
	GCP_SECURITY_SCOPE_ROLE,
	gcpConnectorResourceNames,
} from "@maple/domain/gcp"
import {
	type GcpConnectorId,
	GcpLogRuntime,
	type GcpProjectId,
	type GcpResourceNumber,
	type GcpScopeType,
} from "@maple/primitives"
import { forPaste } from "../paste-script"
import { Array as Arr, String as Str } from "effect"

/**
 * Single-quote a value for bash. Every value a script uses goes through here; the scope named in
 * its header comment is an id the API has pattern-checked.
 */
const sh = (value: string): string => `'${Str.replaceAll("'", `'\\''`)(value)}'`

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

// What each runtime's code writes to stdout and stderr, as Cloud Logging names those logs. The
// runtime's platform logs (request logs, system events, audit) are other logs and stay. A runtime
// that was not chosen has its clause in the filter: a workload that also sends its logs to Maple
// over OpenTelemetry would have each line stored twice, and Google's copy carries no trace link.
const APPLICATION_LOGS = {
	cloud_run: {
		name: "Cloud Run",
		leftOut: 'NOT (log_id("run.googleapis.com/stdout") OR log_id("run.googleapis.com/stderr"))',
	},
	cloud_functions: {
		name: "Cloud Functions (1st gen)",
		leftOut: 'NOT log_id("cloudfunctions.googleapis.com/cloud-functions")',
	},
	app_engine: {
		name: "App Engine",
		leftOut: 'NOT (resource.type="gae_app" AND (log_id("stdout") OR log_id("stderr")))',
	},
	gke: { name: "GKE containers", leftOut: 'NOT resource.type="k8s_container"' },
} satisfies Record<GcpLogRuntime, { readonly name: string; readonly leftOut: string }>

const leftOutRuntimes = (applicationLogs: ReadonlyArray<GcpLogRuntime>) =>
	Arr.filter(GcpLogRuntime.literals, (runtime) => !applicationLogs.includes(runtime))

export const gcpLogFilter = (applicationLogs: ReadonlyArray<GcpLogRuntime>): string =>
	Arr.join(
		[
			...NOISE,
			...Arr.map(leftOutRuntimes(applicationLogs), (runtime) => APPLICATION_LOGS[runtime].leftOut),
		],
		" AND ",
	)

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
# gcloud counts a person's calls against its current project, in Cloud Shell whichever one the
# console has open. They belong to this one, whatever the caller's settings say.
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"
SCOPE_ID=${sh(target.scopeId)}
TOPIC=${sh(names.topic)}
SUBSCRIPTION=${sh(names.subscription)}
SINK=${sh(names.sink)}
SERVICE_ACCOUNT=${sh(names.serviceAccountId)}
SERVICE_ACCOUNT_EMAIL="$SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com"
SECURITY_TOPIC=${sh(names.securityTopic)}
SECURITY_SUBSCRIPTION=${sh(names.securitySubscription)}
NOTIFICATION_CONFIG=${sh(names.notificationConfig)}
PUSH_SERVICE_ACCOUNT=${sh(names.pushServiceAccountId)}
PUSH_SERVICE_ACCOUNT_EMAIL="$PUSH_SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com"
${Arr.join(
	Arr.map(more, (line) => `${line}\n`),
	"",
)}MAPLE_URL=${sh(target.mapleUrl)}
SCOPE="${target.scopeType} $SCOPE_ID"
OWNER="Owner on project $PROJECT_ID"
SINK_ROLE="Logs Configuration Writer on $SCOPE"
IAM_ROLE="${SCOPES[target.scopeType].iamRole} on $SCOPE"
SCC_ROLE="Security Center Notification Configurations Editor on $SCOPE"
`
}

// Google's own output is shown only for a step that fails, under what failed and above what to
// do about it. `stop` ends the script: every step can be run again, so nothing is rolled back.
const output = (unfinished: string, interrupted: string) => `
# ---- What this script prints ----
# Its marks are spelled as bytes: the text you paste is plain ASCII, which every terminal and
# locale passes on unchanged.
section() { printf '\\n%s\\n' "$1"; }
ok() { printf '  \\342\\234\\223 %s\\n' "$1"; }
note() { printf '  \\342\\200\\242 %s\\n' "$1"; }
# Ctrl-C ends the script between two steps, which a re-run picks up from.
interrupted() { printf '\\n\\n%s\\n' ${sh(interrupted)}; exit 130; }
trap interrupted INT

# stop <what went wrong> <what to do> [Google's answer]
stop() {
  printf '  \\342\\234\\227 %s\\n' "$1"
  # Google can quote the push endpoint back, and this output may be sent to support. The error
  # line says what was refused; the machine-readable details that follow it are left out.
  if [ -n "\${3-}" ]; then
    printf '\\n'
    printf '%s\\n' "$3" | sed -e "/^- '@type':/,\\$d" -e 's/secret=[^ )&"]*/secret=HIDDEN/g' -e 's/maple_gcp_[A-Za-z0-9_-]*/maple_gcp_HIDDEN/g' -e 's/^/      /'
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
      printf '%s' "An organization policy (domain restricted sharing) blocks granting Maple's service account \${MAPLE_SERVICE_ACCOUNT-} on project $PROJECT_ID. Ask an Organization Policy Administrator to allow that one service account, for this project only (iam.managed.allowedPolicyMembers). Don't turn the policy off. See ${DOCS_URL}#domain-restricted-sharing" ;;
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

# conflict <Google's answer>: an IAM change raced another change to the same policy, which gcloud
# does not try again. Trying again is safe: each change is read afresh.
conflict() { case "$1" in *"concurrent policy changes"* | *ABORTED*) return 0 ;; *) return 1 ;; esac; }

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
    note "Couldn't reach Maple to confirm. Maple shows the connection as pending until a later run reaches it."
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
    *"has not been used"* | *"is disabled"*) api_off "$what"; return 1 ;;
  esac
  stop "Couldn't check whether $what still exists." "$(fix "$output" "$role")" "$output"
}

# api_off <what it is>: an API switched off after a setup run would hide what it made. The cleanup
# says so instead of calling it gone; a setup run with the API off has made nothing there.
UNCHECKED=0
api_off() {
  [ "\${ANY_API_OFF_MATTERS-0}" = 1 ] || return 0
  note "Couldn't look for $1: its API is off in project $PROJECT_ID. If a setup run made one, switch the API on and paste this again."
  UNCHECKED=1
}

# remove <line when it worked> <line when it failed> <role that allows it> <gcloud ... delete ...>:
# one that is gone already, a moment after it was seen, is fine.
remove() {
  local worked="$1" failed="$2" role="$3" output
  shift 3
  if ! output="$("$@" 2>&1)"; then
    case "$output" in *NOT_FOUND*) ;; *) stop "$failed" "$(fix "$output" "$role")" "$output" ;; esac
  fi
  ok "$worked"
  REMOVED=1
}

# account_remains <what it is> <gcloud iam service-accounts list ...>: looked up in the list. For
# 30 days after a service account is deleted, describing it answers PERMISSION_DENIED even to an
# Owner, which would read as "may still be there" on every re-run. A list that fails is read like a
# failed describe.
account_remains() {
  local what="$1" output
  shift
  if output="$("$@" 2>/dev/null)"; then
    [ -n "$output" ]
    return
  fi
  output="$("$@" 2>&1 || true)"
  case "$output" in *"has not been used"* | *"is disabled"*) api_off "$what"; return 1 ;; esac
  stop "Couldn't check whether $what still exists." "$(fix "$output" "$OWNER")" "$output"
}

# unbind <role that allows it> <gcloud ... remove-iam-policy-binding ...>: a binding that is
# already gone is fine. UNBOUND says whether one was there.
UNBOUND=0
unbind() {
  local role="$1" output tries=0
  shift
  until output="$("$@" 2>&1)"; do
    case "$output" in *"Policy binding"*"not found"*) return 0 ;; esac
    tries=$((tries + 1))
    if ! conflict "$output" || [ "$tries" -ge 20 ]; then
      stop "Couldn't remove the read-only roles." "$(fix "$output" "$role")" "$output"
    fi
    sleep 3
  done
  UNBOUND=1
}
`

// gcloud's calls are counted against the host project (CLOUDSDK_CORE_PROJECT), or for a service
// account against its own project. With the Cloud Resource Manager API off there, every describe
// and role grant fails.
const apisOff = (
	scopeType: GcpScopeType,
	apis: ReadonlyArray<string>,
) => `# Which of the APIs this script needs are off in ${hostProject(scopeType)}, asked once.
APIS_OFF="$(off ${Arr.join(apis, " ")})"
# gcloud needs the Cloud Resource Manager API of the project its calls are counted against: this
# one, or a service account's own project, usually this one too. So it is switched on before the
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
  local resource="$1" where="$2" ask="$3" answer permission lacking="" held=0 nl=$'\\n'
  shift 3
  if ! answer="$(curl -sS --max-time 15 -w '\\n%{http_code}' -X POST -H 'Content-Type: application/json' \\
    -H @<(printf 'Authorization: Bearer %s\\n' "$TOKEN") \\
    --data "{\\"permissions\\":[$(printf '"%s",' "$@" | sed 's/,$//')]}" \\
    "https://cloudresourcemanager.googleapis.com/v3/$resource:testIamPermissions" 2>/dev/null)"; then
    CHECKED=0
    return 0
  fi
  # Google refuses to answer for a folder or organization that this account can't see, or that
  # does not exist: as good a sign of a wrong ID as having none of the permissions.
  case "\${answer##*$nl}" in
    200) answer="\${answer%$nl*}" ;;
    403 | 404)
      case "$answer" in *SERVICE_DISABLED* | *"has not been used"*) CHECKED=0; return 0 ;; esac
      stop "$ACCOUNT can't see $where." "Check the ID in Maple. ${WRONG_ID} If it is right, this account has no rights there. $ask" ;;
    *) CHECKED=0; return 0 ;;
  esac
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
# Before 470, \`gcloud logging sinks update\` has no --include-children and every re-run fails.
GCLOUD_VERSION="$(gcloud version --format='value("Google Cloud SDK")' 2>/dev/null || true)"
case "$GCLOUD_VERSION" in [0-9].* | [0-9][0-9].* | [0-3][0-9][0-9].* | 4[0-6][0-9].*)
  stop "gcloud $GCLOUD_VERSION is too old for this script." "Update it (gcloud components update, or through the package manager that installed it), or run the script in Cloud Shell: https://shell.cloud.google.com" ;;
esac
ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
TOKEN="$(gcloud auth print-access-token 2>/dev/null || true)"
if [ -z "$ACCOUNT" ] || [ -z "$TOKEN" ]; then
  stop "You are not signed in to Google Cloud." "In Cloud Shell, click Authorize when it asks. Elsewhere, run: gcloud auth login"
fi
# With impersonation set, gcloud acts as that service account: it is the one that needs the roles.
IMPERSONATED="$(gcloud config get-value auth/impersonate_service_account 2>/dev/null || true)"
[ -z "$IMPERSONATED" ] || ACCOUNT="$IMPERSONATED"
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
  *) note "Couldn't tell whether billing is on. Cloud Monitoring only answers for projects with billing." ;;
esac
`
		: ""
}${
	checks.permissions.length === 0
		? ""
		: `${PERMISSION_CHECK}${Arr.join(
				Arr.map(
					checks.permissions,
					([resource, where, ask, permissions]) =>
						`allowed "${resource}" "${where}" "${ask}" \\\n  ${Arr.join(permissions, " ")}\n`,
				),
				"",
			)}# Switching an API on takes a right of its own, asked about only when one is off.
[ -z "$APIS_OFF" ] || allowed "projects/$PROJECT_ID" "project $PROJECT_ID" "This script has to switch on:$APIS_OFF. Ask for Service Usage Admin there, or have an administrator switch them on." \\
  serviceusage.services.enable
if [ "$CHECKED" = 1 ]; then
  ok "$ACCOUNT has the permissions this script needs"
else
  note "Couldn't ask Google which permissions $ACCOUNT holds. A step it may not take says so."
fi
`
}${checks.sink === undefined ? "" : sinkAndFilter(checks.sink)}`

/** What the enabled sections need, asked of Google before the first change. */
const permissionChecks = (
	scopeType: GcpScopeType,
	logs: boolean,
	metrics: boolean,
	security: boolean,
): AccessChecks["permissions"] => {
	if (!logs && !metrics && !security) return []
	const scope = SCOPES[scopeType]
	const administrator = "or have an administrator run this script."
	const reader = metrics || security
	const pubsub = [
		"pubsub.topics.get",
		"pubsub.topics.create",
		"pubsub.topics.attachSubscription",
		"pubsub.topics.setIamPolicy",
		"pubsub.subscriptions.get",
		"pubsub.subscriptions.create",
		"pubsub.subscriptions.update",
	]
	const host = dedupe([
		"resourcemanager.projects.getIamPolicy",
		"resourcemanager.projects.setIamPolicy",
		// The gets: a resource the caller may not look at is taken for missing and created again,
		// which Google refuses as a duplicate.
		...(logs ? [...pubsub, "pubsub.topics.publish"] : []),
		...(security ? pubsub : []),
		...(reader
			? ["iam.serviceAccounts.get", "iam.serviceAccounts.create", "iam.serviceAccounts.setIamPolicy"]
			: []),
		// A subscription that signs as the push service account needs its caller to act as it.
		...(security ? ["iam.serviceAccounts.actAs"] : []),
	])
	const sink = logs ? ["logging.sinks.get", "logging.sinks.create", "logging.sinks.update"] : []
	const notifications = security
		? [
				"securitycenter.notificationconfig.get",
				"securitycenter.notificationconfig.create",
				"securitycenter.notificationconfig.update",
			]
		: []
	const askHost = `Ask for Owner there, ${administrator}`
	if (scopeType === "project") {
		return [
			["projects/$PROJECT_ID", "project $PROJECT_ID", askHost, [...host, ...sink, ...notifications]],
		]
	}
	const roles = [
		...(logs ? ["Logs Configuration Writer"] : []),
		...(reader ? [scope.iamRole] : []),
		...(security ? ["Security Center Notification Configurations Editor"] : []),
	]
	return [
		["projects/$PROJECT_ID", "project $PROJECT_ID", askHost, host],
		[
			`${scopeType}s/$SCOPE_ID`,
			"$SCOPE",
			`Ask for ${Arr.join(roles, " and ")} there, ${administrator} If the ID looks wrong, check it with: ${scope.list}`,
			[...sink, ...notifications, ...(reader ? [`resourcemanager.${scopeType}s.setIamPolicy`] : [])],
		],
	]
}

const dedupe = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)]

// Setup only: granting to a service account Google may not have published yet, its own for the
// log sink or the reader this script creates.
const GRANT = `
# grant <line when it failed> <role that allows it> <gcloud ... add-iam-policy-binding ...>
# Waited out, for a minute at most: a change that raced another one, and a service account Google
# has not published yet. Until then it answers that the account does not exist, or for the policy
# of a reader this run created (gcloud iam service-accounts ...), that the caller may not change it.
WAITED=0
grant() {
  local failed="$1" role="$2" output tries=0
  shift 2
  while ! output="$("$@" 2>&1)"; do
    tries=$((tries + 1))
    conflict "$output" || case "$output" in
      *"does not exist"* | *NOT_FOUND*) ;;
      *PERMISSION_DENIED*) { [ "$ACCOUNT_CREATED$PUSH_ACCOUNT_CREATED" != 00 ] && [ "$3" = service-accounts ]; } || tries=20 ;;
      *) tries=20 ;;
    esac
    if [ "$tries" -ge 20 ]; then stop "$failed" "$(fix "$output" "$role")" "$output"; fi
    if [ "$WAITED" = 0 ] && ! conflict "$output"; then
      printf '  \\342\\200\\246 waiting for Google to publish the new service account\\n'
      WAITED=1
    fi
    sleep 3
  done
}
`

// How a push subscription delivers: GCP_PUSH_SUBSCRIPTION, as gcloud's flags.
const DELIVERY_FLAGS = `  --ack-deadline=30 --message-retention-duration=1d --expiration-period=never
  --min-retry-delay=10s --max-retry-delay=600s`

const logsSetup = (scopeType: GcpScopeType): string => `
# ---- Log forwarding: on ----
section "Log forwarding"
DESTINATION="pubsub.googleapis.com/projects/$PROJECT_ID/topics/$TOPIC"

# APIs in ${hostProject(scopeType)}: Pub/Sub carries the log entries, Cloud Logging routes them,
# and Cloud Resource Manager is what gcloud grants the roles below through.
apis "Pub/Sub, Cloud Logging, Cloud Resource Manager" ${Arr.join(GCP_LOG_APIS, " ")}

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
${DELIVERY_FLAGS}
)
# A subscription outlives a deleted topic, and one that was detached stays detached: neither gets
# a message again, and its topic can't be changed. Such a subscription is made anew.
subscribed() {
  gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT_ID" --format="value($1)" 2>/dev/null || true
}
SUBSCRIBED="$(subscribed topic)"
if [ -n "$SUBSCRIBED" ] &&
  { [ "$SUBSCRIBED" != "projects/$PROJECT_ID/topics/$TOPIC" ] || [ "$(subscribed detached)" = True ]; }; then
  run "Push subscription cut off from the topic deleted" "Couldn't delete the push subscription." "$OWNER" \\
    gcloud pubsub subscriptions delete "$SUBSCRIPTION" --project="$PROJECT_ID" --quiet
  SUBSCRIBED=""
fi
if [ -n "$SUBSCRIBED" ]; then
  run "Push subscription up to date" "Couldn't update the push subscription." "$OWNER" \\
    gcloud pubsub subscriptions update "$SUBSCRIPTION" "\${SUBSCRIPTION_FLAGS[@]}"
else
  run "Push subscription created" "Couldn't create the push subscription." "$OWNER" \\
    gcloud pubsub subscriptions create "$SUBSCRIPTION" --topic="$TOPIC" "\${SUBSCRIPTION_FLAGS[@]}"
fi

# --no-disabled: a sink someone paused forwards again, as log forwarding is on in Maple.
if [ "$SINK_EXISTS" = 1 ]; then
  if [ "$LOG_FILTER_MODE" = set ]; then
    run "Log sink up to date (filter replaced)" "Couldn't update the log sink." "$SINK_ROLE" \\
      gcloud logging sinks update "$SINK" "$DESTINATION" --no-disabled --log-filter="$LOG_FILTER" ${SCOPES[scopeType].sink}${includeChildren(scopeType)}
    FILTER_REPLACED=1
  else
    run "Log sink up to date (filter kept)" "Couldn't update the log sink." "$SINK_ROLE" \\
      gcloud logging sinks update "$SINK" "$DESTINATION" --no-disabled ${SCOPES[scopeType].sink}${includeChildren(scopeType)}
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
[ -n "$WRITER_IDENTITY" ] ||
  stop "Google named no identity for the log sink to write as." "Wait a minute and paste the script again."
grant "Couldn't grant the sink Logs Writer." "$OWNER" \\
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \\
  --member="$WRITER_IDENTITY" --role=roles/logging.logWriter --condition=None
ok "Sink allowed to write to the project"
grant "Couldn't grant the sink Pub/Sub Publisher." "$OWNER" \\
  gcloud pubsub topics add-iam-policy-binding "$TOPIC" --project="$PROJECT_ID" \\
  --member="$WRITER_IDENTITY" --role=roles/pubsub.publisher
ok "Sink allowed to publish to the topic"
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
  remove "Log sink deleted" "Couldn't delete the log sink." "$SINK_ROLE" \\
    gcloud logging sinks delete "$SINK" ${SCOPES[scopeType].sink} --quiet
  printf '  \\342\\200\\246 waiting a minute for Google to stop routing to the topic\\n'
  sleep 60
fi
if remains "the push subscription" "$OWNER" gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT_ID"; then
  remove "Push subscription deleted" "Couldn't delete the push subscription." "$OWNER" \\
    gcloud pubsub subscriptions delete "$SUBSCRIPTION" --project="$PROJECT_ID" --quiet
fi
if remains "the topic" "$OWNER" gcloud pubsub topics describe "$TOPIC" --project="$PROJECT_ID"; then
  remove "Topic deleted" "Couldn't delete the Pub/Sub topic." "$OWNER" \\
    gcloud pubsub topics delete "$TOPIC" --project="$PROJECT_ID" --quiet
fi
[ "$REMOVED" = 1 ] || ok "Nothing left to remove"
${notifies ? `notify "Maple notified" '"logs":false'\n` : ""}`

const serviceAccountMember = '--member="serviceAccount:$SERVICE_ACCOUNT_EMAIL"'

const METRICS_READER_NAME = "Maple metrics and resource reader"
const SECURITY_READER_NAME = "Maple security findings reader"

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
  ${Arr.join(GCP_METRIC_APIS, " ")}

# A service account that an earlier run deleted (metrics switched off) fails this describe as
# well and is created again. Google makes that a new account under the same name, with none of
# the old one's roles, so every grant below is made for it.
if exists gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID"; then
  ok "Read-only service account already exists"
else
  run "Read-only service account created" "Couldn't create the service account." "$OWNER" \\
    gcloud iam service-accounts create "$SERVICE_ACCOUNT" --project="$PROJECT_ID" \\
    --display-name="${METRICS_READER_NAME}"
  ACCOUNT_CREATED=1
fi

# Read-only roles on the ${scopeType}${scopeType === "project" ? "" : ", inherited by every project under it"}:
#   roles/monitoring.viewer  read metrics (monitoring.timeSeries.list)
#   roles/cloudasset.viewer  list resources (cloudasset.assets.searchAllResources)
# These are the narrowest predefined roles for the two calls. Both are read-only, and broader
# than the calls: Cloud Asset Viewer can also read resource metadata and IAM policies.
for ROLE in ${Arr.join(GCP_READER_SCOPE_ROLES, " ")}; do
  grant "Couldn't grant the read-only roles." "$IAM_ROLE" \\
    ${SCOPES[scopeType].gcloud} add-iam-policy-binding "$SCOPE_ID" \\
    ${serviceAccountMember} --role="$ROLE" --condition=None
done
# Maple's reads name this project as the one their quota is counted against, which takes
# serviceusage.services.use on it.
grant "Couldn't grant the read-only roles." "$OWNER" \\
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \\
  ${serviceAccountMember} --role=${GCP_READER_PROJECT_ROLE} --condition=None
ok "Read-only roles granted (Monitoring Viewer, Cloud Asset Viewer, Service Usage Consumer)"

# Maple's own account may mint short-lived tokens for this one service account, nothing else.
grant "Couldn't let Maple use the service account." "$OWNER" \\
  gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" \\
  --member="serviceAccount:$MAPLE_SERVICE_ACCOUNT" --role=roles/iam.serviceAccountTokenCreator \\
  --condition=None
ok "Maple allowed to read as that account"
`

const ACCOUNT_LIST = `gcloud iam service-accounts list --project="$PROJECT_ID" \\
  --filter="email=$SERVICE_ACCOUNT_EMAIL" --format='value(email)'`

const unbindScopeRoles = (scopeType: GcpScopeType, roles: ReadonlyArray<string>) =>
	`for ROLE in ${Arr.join(roles, " ")}; do
    unbind "$IAM_ROLE" ${SCOPES[scopeType].gcloud} remove-iam-policy-binding "$SCOPE_ID" \\
      ${serviceAccountMember} --role="$ROLE" --all
  done`

/** `keepAccount`: security findings still read through the account, so only the metrics roles go. */
const metricsRemoval = (scopeType: GcpScopeType, keepAccount: boolean): string => `
# ---- Metrics and resources: off. Remove what an earlier run created. ----
section "Metrics and resources"
${
	keepAccount
		? `# The read-only service account stays: Security Command Center findings are read through it.
UNBOUND=0
if account_remains "the read-only service account" ${ACCOUNT_LIST}; then
  ${unbindScopeRoles(scopeType, GCP_READER_SCOPE_ROLES)}
fi
if [ "$UNBOUND" = 1 ]; then
  ok "Metrics roles removed"
  REMOVED=1
else
  ok "Nothing left to remove"
fi
`
		: `if account_remains "the read-only service account" ${ACCOUNT_LIST}; then
  # Role bindings first: once the account is deleted they can no longer be removed by name.
  ${unbindScopeRoles(scopeType, [...GCP_READER_SCOPE_ROLES, GCP_SECURITY_SCOPE_ROLE])}
  unbind "$OWNER" gcloud projects remove-iam-policy-binding "$PROJECT_ID" \\
    ${serviceAccountMember} --role=${GCP_READER_PROJECT_ROLE} --all
  ok "Read-only roles removed"
  remove "Read-only service account deleted" "Couldn't delete the service account." "$OWNER" \\
    gcloud iam service-accounts delete "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" --quiet
else
  ok "Nothing left to remove"
fi
`
}`

// Security Command Center takes the scope as --organization, --folder or --project, like a sink.
// Without data residency the only location is global.
const sccParent = (scopeType: GcpScopeType) => `${SCOPES[scopeType].sink} --location=global`

/** `readerHere`: metrics are off, so this section makes the read-only account Maple reads as. */
const securitySetup = (scopeType: GcpScopeType, readerHere: boolean): string => `
# ---- Security findings: on ----
section "Security findings"

# APIs in ${hostProject(scopeType)}:
#   securitycenter.googleapis.com  Security Command Center, to read findings and send each new one
#   pubsub.googleapis.com          carries the findings to Maple
#   iam.googleapis.com, iamcredentials.googleapis.com  the service accounts below; no key is created
#   cloudresourcemanager.googleapis.com  what gcloud grants the roles below through
apis "Security Command Center, Pub/Sub, IAM, IAM Credentials, Cloud Resource Manager" \\
  ${Arr.join(GCP_SECURITY_APIS, " ")}
${
	readerHere
		? `
if exists gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID"; then
  ok "Read-only service account already exists"
else
  run "Read-only service account created" "Couldn't create the service account." "$OWNER" \\
    gcloud iam service-accounts create "$SERVICE_ACCOUNT" --project="$PROJECT_ID" \\
    --display-name="${SECURITY_READER_NAME}"
  ACCOUNT_CREATED=1
fi
`
		: ""
}
# roles/securitycenter.findingsViewer on the ${scopeType}: reads findings, changes nothing.
grant "Couldn't grant the findings role." "$IAM_ROLE" \\
  ${SCOPES[scopeType].gcloud} add-iam-policy-binding "$SCOPE_ID" \\
  ${serviceAccountMember} --role=${GCP_SECURITY_SCOPE_ROLE} --condition=None
${
	readerHere
		? `grant "Couldn't grant the read-only roles." "$OWNER" \\
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \\
  ${serviceAccountMember} --role=${GCP_READER_PROJECT_ROLE} --condition=None
ok "Read-only roles granted (Security Center Findings Viewer, Service Usage Consumer)"
grant "Couldn't let Maple use the service account." "$OWNER" \\
  gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" \\
  --member="serviceAccount:$MAPLE_SERVICE_ACCOUNT" --role=roles/iam.serviceAccountTokenCreator \\
  --condition=None
ok "Maple allowed to read as that account"
`
		: `ok "Read-only role granted (Security Center Findings Viewer)"
`
}
# Made first: Google creates the Pub/Sub service agent the grant below names with a first topic.
if exists gcloud pubsub topics describe "$SECURITY_TOPIC" --project="$PROJECT_ID"; then
  ok "Findings topic already exists"
else
  run "Findings topic created" "Couldn't create the findings topic." "$OWNER" \\
    gcloud pubsub topics create "$SECURITY_TOPIC" --project="$PROJECT_ID"
fi

# What Pub/Sub signs each push to Maple as, so the address carries no secret. It holds no role.
if exists gcloud iam service-accounts describe "$PUSH_SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID"; then
  ok "Push service account already exists"
else
  run "Push service account created" "Couldn't create the push service account." "$OWNER" \\
    gcloud iam service-accounts create "$PUSH_SERVICE_ACCOUNT" --project="$PROJECT_ID" \\
    --display-name="Maple push identity" --description="Signs Pub/Sub push requests to Maple. Holds no roles."
  PUSH_ACCOUNT_CREATED=1
fi
# Pub/Sub's service agent mints the push tokens. Google names it by the project's number.
if ! PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null)" ||
  [ -z "$PROJECT_NUMBER" ]; then
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" 2>&1 || true)"
  stop "Couldn't read the number of project $PROJECT_ID." "$(fix "$PROJECT_NUMBER" "$OWNER")" "$PROJECT_NUMBER"
fi
grant "Couldn't let Pub/Sub sign as the push service account." "$OWNER" \\
  gcloud iam service-accounts add-iam-policy-binding "$PUSH_SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" \\
  --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" \\
  --role=roles/iam.serviceAccountTokenCreator --condition=None
ok "Pub/Sub allowed to sign as that account"

# One finding per request, unwrapped, with a token Google signs as the push service account for
# Maple's address. A subscription cut off from its topic is made anew, as for logs.
SECURITY_SUBSCRIPTION_FLAGS=(
  --project="$PROJECT_ID"
  --push-endpoint="$SECURITY_PUSH_ENDPOINT" --push-no-wrapper
  --push-auth-service-account="$PUSH_SERVICE_ACCOUNT_EMAIL" --push-auth-token-audience="$SECURITY_PUSH_ENDPOINT"
${DELIVERY_FLAGS}
)
security_subscribed() {
  gcloud pubsub subscriptions describe "$SECURITY_SUBSCRIPTION" --project="$PROJECT_ID" --format="value($1)" 2>/dev/null || true
}
SECURITY_SUBSCRIBED="$(security_subscribed topic)"
if [ -n "$SECURITY_SUBSCRIBED" ] &&
  { [ "$SECURITY_SUBSCRIBED" != "projects/$PROJECT_ID/topics/$SECURITY_TOPIC" ] || [ "$(security_subscribed detached)" = True ]; }; then
  run "Findings subscription cut off from the topic deleted" "Couldn't delete the findings subscription." "$OWNER" \\
    gcloud pubsub subscriptions delete "$SECURITY_SUBSCRIPTION" --project="$PROJECT_ID" --quiet
  SECURITY_SUBSCRIBED=""
fi
if [ -n "$SECURITY_SUBSCRIBED" ]; then
  run "Findings subscription up to date" "Couldn't update the findings subscription." "$OWNER" \\
    gcloud pubsub subscriptions update "$SECURITY_SUBSCRIPTION" "\${SECURITY_SUBSCRIPTION_FLAGS[@]}"
else
  run "Findings subscription created" "Couldn't create the findings subscription." "$OWNER" \\
    gcloud pubsub subscriptions create "$SECURITY_SUBSCRIPTION" --topic="$SECURITY_TOPIC" "\${SECURITY_SUBSCRIPTION_FLAGS[@]}"
fi

# Security Command Center sends each finding written or changed on the ${scopeType} to the topic.
# Creating the notification lets its own service agent publish there.
NOTIFICATION_FLAGS=(
  ${sccParent(scopeType)}
  --pubsub-topic="projects/$PROJECT_ID/topics/$SECURITY_TOPIC" --filter="$SECURITY_FILTER"
  --description="Sends Security Command Center findings to Maple."
)
if exists gcloud scc notifications describe "$NOTIFICATION_CONFIG" ${sccParent(scopeType)}; then
  run "Findings notification up to date" "Couldn't update the findings notification." "$SCC_ROLE" \\
    gcloud scc notifications update "$NOTIFICATION_CONFIG" "\${NOTIFICATION_FLAGS[@]}"
else
  run "Findings notification created" "Couldn't create the findings notification." "$SCC_ROLE" \\
    gcloud scc notifications create "$NOTIFICATION_CONFIG" "\${NOTIFICATION_FLAGS[@]}"
  CONFIG_CREATED=1
fi
`

/**
 * `unbindReader`: the read-only account stays for metrics, so only its findings role goes.
 * `removePushAccount`: no log subscription signs as the push service account either.
 */
const securityRemoval = (
	scopeType: GcpScopeType,
	options: { readonly unbindReader: boolean; readonly removePushAccount: boolean },
): string => `
# ---- Security findings: off. Remove what an earlier run created. ----
# Setup makes the topic and subscription before the notification, so without either there is no
# notification of Maple's to look for: a run that never had findings on needs no Security Command
# Center rights. Otherwise the notification goes first, so nothing publishes into a gone topic.
section "Security findings"
REMOVED_BEFORE="$REMOVED"
REMOVED=0
SECURITY_LEFT=""
if remains "the findings subscription" "$OWNER" gcloud pubsub subscriptions describe "$SECURITY_SUBSCRIPTION" --project="$PROJECT_ID"; then
  SECURITY_LEFT="$SECURITY_LEFT subscription"
fi
if remains "the findings topic" "$OWNER" gcloud pubsub topics describe "$SECURITY_TOPIC" --project="$PROJECT_ID"; then
  SECURITY_LEFT="$SECURITY_LEFT topic"
fi
if [ -n "$SECURITY_LEFT" ] &&
  remains "the findings notification" "$SCC_ROLE" gcloud scc notifications describe "$NOTIFICATION_CONFIG" ${sccParent(scopeType)}; then
  remove "Findings notification deleted" "Couldn't delete the findings notification." "$SCC_ROLE" \\
    gcloud scc notifications delete "$NOTIFICATION_CONFIG" ${sccParent(scopeType)} --quiet
fi
case "$SECURITY_LEFT" in *subscription*)
  remove "Findings subscription deleted" "Couldn't delete the findings subscription." "$OWNER" \\
    gcloud pubsub subscriptions delete "$SECURITY_SUBSCRIPTION" --project="$PROJECT_ID" --quiet ;;
esac
case "$SECURITY_LEFT" in *topic*)
  remove "Findings topic deleted" "Couldn't delete the findings topic." "$OWNER" \\
    gcloud pubsub topics delete "$SECURITY_TOPIC" --project="$PROJECT_ID" --quiet ;;
esac
${
	options.removePushAccount
		? `if account_remains "the push service account" gcloud iam service-accounts list --project="$PROJECT_ID" \\
  --filter="email=$PUSH_SERVICE_ACCOUNT_EMAIL" --format='value(email)'; then
  remove "Push service account deleted" "Couldn't delete the push service account." "$OWNER" \\
    gcloud iam service-accounts delete "$PUSH_SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" --quiet
fi
`
		: ""
}${
	options.unbindReader
		? `UNBOUND=0
if account_remains "the read-only service account" ${ACCOUNT_LIST}; then
  unbind "$IAM_ROLE" ${SCOPES[scopeType].gcloud} remove-iam-policy-binding "$SCOPE_ID" \\
    ${serviceAccountMember} --role=${GCP_SECURITY_SCOPE_ROLE} --all
fi
if [ "$UNBOUND" = 1 ]; then
  ok "Findings role removed"
  REMOVED=1
fi
`
		: ""
}[ "$REMOVED" = 1 ] || ok "Nothing left to remove"
[ "$REMOVED_BEFORE" = 0 ] || REMOVED=1
`

export interface GcpSetupScriptInput extends GcpScriptTarget {
	/** The ingest gateway's receiver URL for this connector, including its secret. */
	readonly pushEndpoint: string
	/** Maple's own Google service account. Undefined: the metrics setup is left untouched. */
	readonly mapleServiceAccountEmail: string | undefined
	readonly logsEnabled: boolean
	readonly metricsEnabled: boolean
	/** Security Command Center findings, read through the same service account as metrics. */
	readonly securityEnabled: boolean
	/** The API's receiver for findings: no secret, Pub/Sub signs each push instead. */
	readonly securityPushEndpoint: string
	/** Null: an existing sink keeps its filter, a new one forwards no application output. */
	readonly applicationLogs: ReadonlyArray<GcpLogRuntime> | null
}

/**
 * The script an administrator pastes into Cloud Shell. Logs: a Log Router sink on the scope into
 * a Pub/Sub topic whose push subscription delivers each LogEntry to Maple. Metrics and resources:
 * a read-only service account Maple may impersonate. Security findings: that account reads them, and
 * a Security Command Center notification pushes each one to Maple. The script converges: what the connector has
 * enabled is created or updated, what it has not is removed, so a re-run applies an opt-out. Each
 * section ends by telling Maple what it applied.
 */
export const renderGcpSetupScript = (input: GcpSetupScriptInput) => {
	const { scopeType, logsEnabled: logs } = input
	const applicationLogs = input.applicationLogs ?? []
	const leftOut = Arr.map(leftOutRuntimes(applicationLogs), (runtime) => APPLICATION_LOGS[runtime].name)
	// On for the connector while this deployment has lost its Google identity: nothing is set up
	// and, above all, nothing a customer set up earlier is removed.
	const switched = (enabled: boolean) =>
		!enabled ? "off" : input.mapleServiceAccountEmail === undefined ? "lost" : "on"
	const metrics = switched(input.metricsEnabled)
	const security = switched(input.securityEnabled)
	const state = (on: boolean) => (on ? "on" : "off, removing")
	const LOST = "not available on this Maple deployment, left as is"
	const metricsState = metrics === "lost" ? LOST : state(metrics === "on")
	const securityState = security === "lost" ? LOST : state(security === "on")
	// Metrics and security findings read through one account: it goes once neither is enabled.
	const readerKept = input.metricsEnabled || input.securityEnabled
	return forPaste(
		"Google Cloud",
		"MAPLE_SETUP_SCRIPT",
		`#!/usr/bin/env bash
# Maple setup for Google Cloud ${scopeType} ${input.scopeId}
#   Log forwarding:        ${logs ? "on" : "off"}
#   Metrics and resources: ${metrics === "lost" ? metricsState : metrics}
#   Security findings:     ${security === "lost" ? securityState : security}
# Safe to run again: it sets up what is on and removes what is off.
# Keep it private: PUSH_ENDPOINT contains this connection's secret.
set -euo pipefail
# gcloud would log every argument, the secret too, and the access token to ~/.config/gcloud/logs.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1 CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1
${
	logs
		? `
# ---- Which logs are forwarded ----
# LOG_FILTER leaves out what is high volume and says little about a workload: Data Access audit
# logs, load balancer health checks, Kubernetes lease renewals and VM serial console output.
${
	leftOut.length === 0
		? `# The output of every runtime is forwarded, as chosen in Maple. Logs from workloads that also
# send them over OpenTelemetry are then stored twice.
# Details: ${OTEL_DOCS_URL}`
		: `# It also leaves out what the code of these runtimes writes to stdout and stderr:
#   ${Arr.join(leftOut, ", ")}
# A workload that also sends its logs over OpenTelemetry would have those lines stored twice. The
# choice is made under Log filter in Maple.
# Details: ${OTEL_DOCS_URL}`
}
# LOG_FILTER_MODE keep: an existing sink keeps its filter, a new sink gets LOG_FILTER.
# LOG_FILTER_MODE set:  LOG_FILTER replaces the sink's filter.
# Filter syntax: https://cloud.google.com/logging/docs/view/logging-query-language
LOG_FILTER_MODE=${sh(input.applicationLogs === null ? "keep" : "set")}
LOG_FILTER=${sh(gcpLogFilter(applicationLogs))}
`
		: ""
}${variables(input, [
			`PUSH_ENDPOINT=${sh(input.pushEndpoint)}`,
			...(input.mapleServiceAccountEmail === undefined || (metrics !== "on" && security !== "on")
				? []
				: [`MAPLE_SERVICE_ACCOUNT=${sh(input.mapleServiceAccountEmail)}`]),
			...(security === "on"
				? [
						`SECURITY_PUSH_ENDPOINT=${sh(input.securityPushEndpoint)}`,
						`SECURITY_FILTER=${sh(GCP_SECURITY_NOTIFICATION_FILTER)}`,
					]
				: []),
		])}SINK_CREATED=0
FILTER_REPLACED=0
ACCOUNT_CREATED=0
PUSH_ACCOUNT_CREATED=0
CONFIG_CREATED=0
REMOVED=0
${output(
	"Setup did not finish. Nothing needs undoing: fix this and paste the script again.",
	"Setup interrupted. Nothing needs undoing: paste the script again to finish it.",
)}${notify(logs)}
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
${logs || metrics === "on" || security === "on" ? GRANT : ""}${
			logs && metrics !== "off" && security !== "off" ? "" : REMOVAL_HELPERS
		}
printf 'Maple setup for %s\\n' "$SCOPE"
printf '  Log forwarding          %s\\n  Metrics and resources   %s\\n  Security findings       %s\\n' \\
  ${sh(state(logs))} ${sh(metricsState)} ${sh(securityState)}
${access(scopeType, {
	apis: [
		...new Set([
			...(logs ? GCP_LOG_APIS : []),
			...(metrics === "on" ? GCP_METRIC_APIS : []),
			...(security === "on" ? GCP_SECURITY_APIS : []),
		]),
	],
	sink: logs ? SCOPES[scopeType].sink : undefined,
	scopeMustOpen: metrics === "on" || security === "on",
	billing: metrics === "on",
	permissions: permissionChecks(scopeType, logs, metrics === "on", security === "on"),
})}${logs ? logsSetup(scopeType) : logsRemoval(scopeType, true)}${
			metrics === "on"
				? metricsSetup(scopeType)
				: metrics === "off"
					? metricsRemoval(scopeType, readerKept)
					: ""
		}${
			security === "on"
				? securitySetup(scopeType, metrics !== "on")
				: security === "off"
					? securityRemoval(scopeType, {
							// Metrics off deletes the account, findings role and all; lost leaves it alone.
							unbindReader: metrics === "on",
							removePushAccount: !logs,
						})
					: ""
		}${
			// One report for the read-only account's two uses. A report naming security alone would
			// carry neither key the ingest gateway reads, and be stored as a log line.
			metrics === "lost"
				? ""
				: `notify "Maple notified" '"metrics":${metrics === "on"}${security === "lost" ? "" : `,"security":${security === "on"}`}'\n`
		}
if [ "$SINK_CREATED$ACCOUNT_CREATED$CONFIG_CREATED$REMOVED$FILTER_REPLACED" = 00000 ]; then
  printf '\\nDone. Everything is in place.\\n'
elif [ "$SINK_CREATED$ACCOUNT_CREATED$CONFIG_CREATED$REMOVED" = 0000 ]; then
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
${
	metrics === "on"
		? `if [ "$ACCOUNT_CREATED" = 1 ]; then printf '  Metrics: the first read lands within about 10 minutes.\\n'; fi\n`
		: ""
}${
			security === "on"
				? `if [ "$CONFIG_CREATED" = 1 ]; then printf '  Findings: each one reaches Maple as Security Command Center writes or changes it.\\n'; fi\n`
				: ""
		}`,
	)
}

export interface GcpCleanupScriptInput extends GcpScriptTarget {
	/** Set while the connector exists: the script then tells Maple that it ran. */
	readonly pushEndpoint: string | undefined
}

/** Removes what the setup script created. Without a push endpoint it carries no secret. */
export const renderGcpCleanupScript = (input: GcpCleanupScriptInput) =>
	forPaste(
		"Google Cloud",
		"MAPLE_CLEANUP_SCRIPT",
		`#!/usr/bin/env bash
# Maple cleanup for Google Cloud ${input.scopeType} ${input.scopeId}
# Removes what the Maple setup script created. The APIs it switched on stay on.
# Safe to run again.${input.pushEndpoint === undefined ? "" : "\n# Keep it private: PUSH_ENDPOINT contains this connection's secret."}
set -euo pipefail
# gcloud would log every argument, the secret too, and the access token to ~/.config/gcloud/logs.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1 CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1
${variables(input, input.pushEndpoint === undefined ? [] : [`PUSH_ENDPOINT=${sh(input.pushEndpoint)}`])}REMOVED=0
ANY_API_OFF_MATTERS=1
${output(
	"Cleanup did not finish. Fix this and paste the script again: it continues where it stopped.",
	"Cleanup interrupted. Paste the script again: it continues where it stopped.",
)}${REMOVAL_HELPERS}
printf 'Maple cleanup for %s\\n' "$SCOPE"
${access(input.scopeType, { apis: [], sink: undefined, scopeMustOpen: false, billing: false, permissions: [] })}${logsRemoval(input.scopeType, false)}${securityRemoval(input.scopeType, { unbindReader: false, removePushAccount: true })}${metricsRemoval(input.scopeType, false)}${
			input.pushEndpoint === undefined
				? ""
				: `
# Tells Maple the cleanup ran. Maple refuses this once the connection is deleted, which is fine.
${POST_REPORT} --data "$(report '"logs":false,"metrics":false,"security":false')" "$PUSH_ENDPOINT" >/dev/null 2>&1 || true
`
		}
if [ "$UNCHECKED" = 1 ]; then
  printf '\\nDone, but not all of it could be checked: see above.\\n'
else
  printf '\\nDone. Everything the setup script created is gone.\\n'
fi
printf '  Left in place: the APIs it switched on, and the Logs Writer role of Google'"'"'s logging\\n'
printf '  service account on %s, which other sinks share.\\n' "$PROJECT_ID"
${input.pushEndpoint === undefined ? "" : `printf '  Now disconnect in Maple: %s\\n' "$MAPLE_URL"\n`}`,
	)
