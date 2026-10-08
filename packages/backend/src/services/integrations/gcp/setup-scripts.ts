import { gcpConnectorResourceNames } from "@maple/domain/gcp"
import type { GcpConnectorId, GcpProjectId, GcpResourceNumber, GcpScopeType } from "@maple/domain/primitives"

/** Single-quote a value for bash. Every value that reaches a script goes through here. */
const sh = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

// Data Access audit logs record every API read, and load balancer health-check probes hit each
// backend every few seconds: both are high volume and say little about the workload.
const DEFAULT_LOG_FILTER = [
	'NOT log_id("cloudaudit.googleapis.com/data_access")',
	'NOT httpRequest.userAgent:"GoogleHC"',
]

export const gcpLogFilter = (excludeGkeContainerLogs: boolean): string =>
	[...DEFAULT_LOG_FILTER, ...(excludeGkeContainerLogs ? ['NOT resource.type="k8s_container"'] : [])].join(
		" AND ",
	)

/** What a connector covers and where Maple's own resources live. */
export interface GcpScriptTarget {
	readonly connectorId: GcpConnectorId
	readonly scopeType: GcpScopeType
	readonly scopeId: GcpProjectId | GcpResourceNumber
	/** The host project: topic, subscription and service account are created here. */
	readonly projectId: GcpProjectId
}

// How each scope is addressed: the flag that places a log sink, the command family that edits its
// IAM policy, and the roles the person running the script needs there.
const SCOPES = {
	project: {
		sink: '--project="$SCOPE_ID"',
		iam: "gcloud projects",
		needs: "#   Owner on the project (PROJECT_ID below).",
	},
	folder: {
		sink: '--folder="$SCOPE_ID"',
		iam: "gcloud resource-manager folders",
		needs: `#   Owner on the host project (PROJECT_ID below), which holds Maple's Pub/Sub topic,
#   subscription and service account. On the folder (SCOPE_ID below): Logs Configuration
#   Writer for the log sink, and Folder IAM Admin for the read-only roles.`,
	},
	organization: {
		sink: '--organization="$SCOPE_ID"',
		iam: "gcloud organizations",
		needs: `#   Owner on the host project (PROJECT_ID below), which holds Maple's Pub/Sub topic,
#   subscription and service account. On the organization (SCOPE_ID below): Logs Configuration
#   Writer for the log sink, and Organization Administrator for the read-only roles.`,
	},
} as const

// A folder or organization sink also routes the logs of every project underneath.
const includeChildren = (scopeType: GcpScopeType): string =>
	scopeType === "project" ? "" : " --include-children"

const variables = (target: GcpScriptTarget): string => {
	const names = gcpConnectorResourceNames(target.connectorId)
	return `PROJECT_ID=${sh(target.projectId)}
SCOPE_ID=${sh(target.scopeId)}
TOPIC=${sh(names.topic)}
SUBSCRIPTION=${sh(names.subscription)}
SINK=${sh(names.sink)}
SERVICE_ACCOUNT=${sh(names.serviceAccountId)}
SERVICE_ACCOUNT_EMAIL="$SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com"`
}

const logsSetup = (scopeType: GcpScopeType, pushEndpoint: string): string => `
# ---- Logs: on ----
PUSH_ENDPOINT=${sh(pushEndpoint)}
DESTINATION="pubsub.googleapis.com/projects/$PROJECT_ID/topics/$TOPIC"

# APIs in the host project: Pub/Sub carries the log entries, Cloud Logging routes them.
gcloud services enable pubsub.googleapis.com logging.googleapis.com --project="$PROJECT_ID"

if ! gcloud pubsub topics describe "$TOPIC" --project="$PROJECT_ID" >/dev/null 2>&1; then
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
if gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud pubsub subscriptions update "$SUBSCRIPTION" "\${SUBSCRIPTION_FLAGS[@]}"
else
  gcloud pubsub subscriptions create "$SUBSCRIPTION" --topic="$TOPIC" "\${SUBSCRIPTION_FLAGS[@]}"
fi

if gcloud logging sinks describe "$SINK" ${SCOPES[scopeType].sink} >/dev/null 2>&1; then
  gcloud logging sinks update "$SINK" "$DESTINATION" --log-filter="$LOG_FILTER" ${SCOPES[scopeType].sink}${includeChildren(scopeType)}
else
  gcloud logging sinks create "$SINK" "$DESTINATION" --log-filter="$LOG_FILTER" ${SCOPES[scopeType].sink}${includeChildren(scopeType)}
fi

# The sink writes as a Google-managed identity. Google requires Logs Writer for it on the project
# that holds the destination, and it needs Pub/Sub Publisher on this one topic.
WRITER_IDENTITY="$(gcloud logging sinks describe "$SINK" ${SCOPES[scopeType].sink} --format='value(writerIdentity)')"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \\
  --member="$WRITER_IDENTITY" --role=roles/logging.logWriter --condition=None >/dev/null
gcloud pubsub topics add-iam-policy-binding "$TOPIC" --project="$PROJECT_ID" \\
  --member="$WRITER_IDENTITY" --role=roles/pubsub.publisher >/dev/null
`

// Removal must not take "could not look" for "not there": a sink the caller may not see would
// otherwise be left routing into a topic the next step deletes.
const REMOVAL_HELPERS = `
# exists <gcloud ... describe ...>: whether a resource is there. NOT_FOUND means it is not, and so
# does a disabled API for the host project's own resources, which cannot exist without it (a
# sink can). Any other failure (a missing permission, for example) is shown and makes this script
# end with an error, because the resource may still be there.
INCOMPLETE=0
exists() {
  local output
  if output="$("$@" 2>&1)"; then return 0; fi
  case "$2:$output" in
    *NOT_FOUND*) ;;
    logging:*) echo "$output" >&2; INCOMPLETE=1 ;;
    *"has not been used"* | *"is disabled"*) ;;
    *) echo "$output" >&2; INCOMPLETE=1 ;;
  esac
  return 1
}
`

const REMOVAL_CHECK = `
if [ "$INCOMPLETE" = 1 ]; then
  echo "Not everything could be removed. See the errors above, then re-run." >&2
  exit 1
fi
`

const logsRemoval = (scopeType: GcpScopeType): string => `
# ---- Logs: off. Remove what an earlier run created. ----
# The Logs Writer grant on the host project stays: the sink wrote as the logging service agent
# of the ${scopeType}, an identity every other sink there shares.
if exists gcloud logging sinks describe "$SINK" ${SCOPES[scopeType].sink}; then
  gcloud logging sinks delete "$SINK" ${SCOPES[scopeType].sink} --quiet
fi
if exists gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project="$PROJECT_ID"; then
  gcloud pubsub subscriptions delete "$SUBSCRIPTION" --project="$PROJECT_ID" --quiet
fi
if exists gcloud pubsub topics describe "$TOPIC" --project="$PROJECT_ID"; then
  gcloud pubsub topics delete "$TOPIC" --project="$PROJECT_ID" --quiet
fi
`

const serviceAccountMember = '--member="serviceAccount:$SERVICE_ACCOUNT_EMAIL"'

const metricsSetup = (scopeType: GcpScopeType, mapleServiceAccountEmail: string): string => `
# ---- Metrics and resources: on ----
MAPLE_SERVICE_ACCOUNT=${sh(mapleServiceAccountEmail)}

# APIs in the host project, the project Maple's reads are made through:
#   monitoring.googleapis.com      Cloud Monitoring, to read metrics
#   cloudasset.googleapis.com      Cloud Asset Inventory, to list resources
#   iam.googleapis.com             to create the service account below
#   iamcredentials.googleapis.com  short-lived tokens for that account; no key is ever created
gcloud services enable monitoring.googleapis.com cloudasset.googleapis.com \\
  iam.googleapis.com iamcredentials.googleapis.com --project="$PROJECT_ID"

if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT" --project="$PROJECT_ID" \\
    --display-name="Maple metrics and resource reader"
fi

# A new service account can take a minute to become visible to IAM.
retry() {
  for _ in 1 2 3 4 5 6; do
    "$@" && return
    sleep 10
  done
  "$@"
}

# Read-only roles on the ${scopeType}${scopeType === "project" ? "" : ", inherited by every project under it"}:
#   roles/monitoring.viewer  read metrics (monitoring.timeSeries.list)
#   roles/cloudasset.viewer  list resources (cloudasset.assets.searchAllResources)
# These are the narrowest predefined roles for the two calls. Both are read-only, and broader
# than the calls: Cloud Asset Viewer can also read resource metadata and IAM policies.
for ROLE in roles/monitoring.viewer roles/cloudasset.viewer; do
  retry ${SCOPES[scopeType].iam} add-iam-policy-binding "$SCOPE_ID" \\
    ${serviceAccountMember} --role="$ROLE" --condition=None >/dev/null
done

# Cloud Asset Inventory checks serviceusage.services.use on the project its API is called through.
retry gcloud projects add-iam-policy-binding "$PROJECT_ID" \\
  ${serviceAccountMember} --role=roles/serviceusage.serviceUsageConsumer --condition=None >/dev/null

# Maple's own account may mint short-lived tokens for this one service account, nothing else.
# If an organization policy rejects this (domain-restricted sharing,
# constraints/iam.allowedPolicyMemberDomains), allow Maple's account there and re-run.
retry gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" \\
  --member="serviceAccount:$MAPLE_SERVICE_ACCOUNT" --role=roles/iam.serviceAccountTokenCreator \\
  --condition=None >/dev/null
`

const metricsRemoval = (scopeType: GcpScopeType): string => `
# ---- Metrics and resources: off. Remove what an earlier run created. ----
if exists gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID"; then
  # Role bindings first, or the deleted account would stay listed in the IAM policy.
  for ROLE in roles/monitoring.viewer roles/cloudasset.viewer; do
    ${SCOPES[scopeType].iam} remove-iam-policy-binding "$SCOPE_ID" \\
      ${serviceAccountMember} --role="$ROLE" --condition=None >/dev/null || INCOMPLETE=1
  done
  gcloud projects remove-iam-policy-binding "$PROJECT_ID" \\
    ${serviceAccountMember} --role=roles/serviceusage.serviceUsageConsumer --condition=None >/dev/null || INCOMPLETE=1
  gcloud iam service-accounts delete "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" --quiet
fi
`

export interface GcpSetupScriptInput extends GcpScriptTarget {
	/** The ingest gateway's receiver URL for this connector, including its secret. */
	readonly pushEndpoint: string
	/** Maple's own Google service account. Undefined: metrics cannot be set up. */
	readonly mapleServiceAccountEmail: string | undefined
	readonly logsEnabled: boolean
	readonly metricsEnabled: boolean
	readonly excludeGkeContainerLogs: boolean
}

/**
 * The script an administrator runs in Cloud Shell. Logs: a Log Router sink on the scope into a
 * Pub/Sub topic whose push subscription delivers each LogEntry to Maple. Metrics and resources: a
 * read-only service account Maple may impersonate. The script converges: what the connector has
 * enabled is created or updated, what it has not is removed, so a re-run applies an opt-out.
 */
export const renderGcpSetupScript = (input: GcpSetupScriptInput): string => {
	const mapleAccount = input.metricsEnabled ? input.mapleServiceAccountEmail : undefined
	const logs = input.logsEnabled
		? {
				note: "#\n# Keep this script private: PUSH_ENDPOINT contains this connector's secret.\n",
				filter: `
# ---- Edit this to change which logs are forwarded, then re-run. ----
# Cloud Logging query language: https://cloud.google.com/logging/docs/view/logging-query-language
LOG_FILTER=${sh(gcpLogFilter(input.excludeGkeContainerLogs))}
# --------------------------------------------------------------------
`,
				section: logsSetup(input.scopeType, input.pushEndpoint),
			}
		: { note: "", filter: "", section: logsRemoval(input.scopeType) }
	const removes = !input.logsEnabled || mapleAccount === undefined
	return `#!/usr/bin/env bash
# Maple: connect a Google Cloud ${input.scopeType} to Maple.
#   Logs:                  ${input.logsEnabled ? "on" : "off"}
#   Metrics and resources: ${mapleAccount === undefined ? "off" : "on"}
# Run in Cloud Shell. Safe to re-run: it sets up what is on and removes what is off.
#
# You need:
${SCOPES[input.scopeType].needs}
${logs.note}set -euo pipefail
${logs.filter}
${variables(input)}
${removes ? REMOVAL_HELPERS : ""}${logs.section}${
		mapleAccount === undefined
			? metricsRemoval(input.scopeType)
			: metricsSetup(input.scopeType, mapleAccount)
	}${removes ? REMOVAL_CHECK : ""}
echo "Maple setup complete."
`
}

/** Removes what the setup script created. Carries no secret, so it outlives the connector. */
export const renderGcpCleanupScript = (target: GcpScriptTarget): string =>
	`#!/usr/bin/env bash
# Maple: remove what the Maple setup script created for a Google Cloud ${target.scopeType}.
# Run in Cloud Shell. Safe to re-run. APIs the setup enabled stay enabled.
#
# You need:
${SCOPES[target.scopeType].needs}
set -euo pipefail

${variables(target)}
${REMOVAL_HELPERS}${logsRemoval(target.scopeType)}${metricsRemoval(target.scopeType)}${REMOVAL_CHECK}
echo "Maple cleanup complete."
`
