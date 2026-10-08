import { gcpConnectorResourceNames } from "@maple/domain/gcp"
import type { GcpConnectorId, GcpProjectId } from "@maple/domain/primitives"

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

const logVariables = (connectorId: GcpConnectorId, projectId: GcpProjectId): string => {
	const names = gcpConnectorResourceNames(connectorId)
	return `PROJECT_ID=${sh(projectId)}
TOPIC=${sh(names.topic)}
SUBSCRIPTION=${sh(names.subscription)}
SINK=${sh(names.sink)}`
}

const serviceAccountVariables = (connectorId: GcpConnectorId): string =>
	`SERVICE_ACCOUNT=${sh(gcpConnectorResourceNames(connectorId).serviceAccountId)}
SERVICE_ACCOUNT_EMAIL="$SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com"`

const metricsSteps = (connectorId: GcpConnectorId, mapleServiceAccountEmail: string): string => `
# Metrics: a read-only service account in this project that Maple may impersonate.
${serviceAccountVariables(connectorId)}
MAPLE_SERVICE_ACCOUNT=${sh(mapleServiceAccountEmail)}

if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT" --project="$PROJECT_ID" \\
    --display-name="Maple metrics reader"
fi

# A new service account can take a minute to become visible to IAM.
retry() {
  for _ in 1 2 3 4 5 6; do
    "$@" && return
    sleep 10
  done
  "$@"
}

retry gcloud projects add-iam-policy-binding "$PROJECT_ID" \\
  --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" --role=roles/monitoring.viewer \\
  --condition=None >/dev/null

retry gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" \\
  --member="serviceAccount:$MAPLE_SERVICE_ACCOUNT" --role=roles/iam.serviceAccountTokenCreator >/dev/null
`

export interface GcpSetupScriptInput {
	readonly connectorId: GcpConnectorId
	readonly projectId: GcpProjectId
	/** The ingest gateway's receiver URL for this connector, including its secret. */
	readonly pushEndpoint: string
	/** Maple's own Google service account. Undefined renders a logs-only script. */
	readonly mapleServiceAccountEmail: string | undefined
	readonly excludeGkeContainerLogs: boolean
}

/**
 * The script a project owner runs in Cloud Shell: a Log Router sink into a Pub/Sub topic whose
 * push subscription delivers each LogEntry to Maple. Every step first looks for the resource, so
 * re-running applies an edited filter instead of failing on what already exists.
 */
export const renderGcpSetupScript = (input: GcpSetupScriptInput): string => {
	const mapleAccount = input.mapleServiceAccountEmail
	const metrics = mapleAccount !== undefined
	return `#!/usr/bin/env bash
# Maple: forward this Google Cloud project's logs${metrics ? " and metrics" : ""} to Maple.
# Run in Cloud Shell as a project owner. Safe to re-run.
# Keep this script private: PUSH_ENDPOINT contains this connector's secret.
set -euo pipefail

# ---- Edit this to change which logs are forwarded, then re-run. ----
# Cloud Logging query language: https://cloud.google.com/logging/docs/view/logging-query-language
LOG_FILTER=${sh(gcpLogFilter(input.excludeGkeContainerLogs))}
# --------------------------------------------------------------------

${logVariables(input.connectorId, input.projectId)}
PUSH_ENDPOINT=${sh(input.pushEndpoint)}
DESTINATION="pubsub.googleapis.com/projects/$PROJECT_ID/topics/$TOPIC"

gcloud services enable pubsub.googleapis.com logging.googleapis.com${
		metrics ? " monitoring.googleapis.com iam.googleapis.com iamcredentials.googleapis.com" : ""
	} \\
  --project="$PROJECT_ID"

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

if gcloud logging sinks describe "$SINK" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud logging sinks update "$SINK" "$DESTINATION" --log-filter="$LOG_FILTER" --project="$PROJECT_ID"
else
  gcloud logging sinks create "$SINK" "$DESTINATION" --log-filter="$LOG_FILTER" --project="$PROJECT_ID"
fi

# The sink writes as a Google-managed identity, which needs to route logs and publish to the topic.
WRITER_IDENTITY="$(gcloud logging sinks describe "$SINK" --project="$PROJECT_ID" --format='value(writerIdentity)')"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \\
  --member="$WRITER_IDENTITY" --role=roles/logging.logWriter --condition=None >/dev/null
gcloud pubsub topics add-iam-policy-binding "$TOPIC" --project="$PROJECT_ID" \\
  --member="$WRITER_IDENTITY" --role=roles/pubsub.publisher >/dev/null
${mapleAccount === undefined ? "" : metricsSteps(input.connectorId, mapleAccount)}
echo "Maple setup complete for $PROJECT_ID. Logs start arriving in Maple within a few minutes."
`
}

/** Removes what the setup script created. Carries no secret, so it outlives the connector. */
export const renderGcpCleanupScript = (connectorId: GcpConnectorId, projectId: GcpProjectId): string =>
	`#!/usr/bin/env bash
# Maple: remove what the Maple setup script created in this Google Cloud project.
# Run in Cloud Shell as a project owner. No "set -e": every step runs, and a
# NOT_FOUND error only means that resource is already gone. The logging service
# agent keeps its Logs Writer role: every sink in the project shares that identity.
set -uo pipefail

${logVariables(connectorId, projectId)}
${serviceAccountVariables(connectorId)}

gcloud logging sinks delete "$SINK" --project="$PROJECT_ID" --quiet
gcloud pubsub subscriptions delete "$SUBSCRIPTION" --project="$PROJECT_ID"
gcloud pubsub topics delete "$TOPIC" --project="$PROJECT_ID"
gcloud projects remove-iam-policy-binding "$PROJECT_ID" \\
  --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" --role=roles/monitoring.viewer \\
  --condition=None >/dev/null
gcloud iam service-accounts delete "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" --quiet

echo "Maple cleanup finished for $PROJECT_ID."
`
