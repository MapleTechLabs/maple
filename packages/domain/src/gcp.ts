import type { GcpConnectorId, GcpScopeType } from "./primitives"

/** The read-only account's roles: on the scope, and on the host project its reads are billed to. */
export const GCP_READER_SCOPE_ROLES = ["roles/monitoring.viewer", "roles/cloudasset.viewer"]
export const GCP_READER_PROJECT_ROLE = "roles/serviceusage.serviceUsageConsumer"

/** APIs in the host project. Cloud Resource Manager is what gcloud reads projects and grants roles through. */
export const GCP_LOG_APIS = [
	"pubsub.googleapis.com",
	"logging.googleapis.com",
	"cloudresourcemanager.googleapis.com",
]
export const GCP_METRIC_APIS = [
	"monitoring.googleapis.com",
	"cloudasset.googleapis.com",
	"iam.googleapis.com",
	"iamcredentials.googleapis.com",
	"cloudresourcemanager.googleapis.com",
]

/** How the push subscription delivers: the setup script's flags, in numbers. */
export const GCP_PUSH_SUBSCRIPTION = {
	ackDeadlineSeconds: 30,
	messageRetentionSeconds: 86_400,
	minRetryDelaySeconds: 10,
	maxRetryDelaySeconds: 600,
} as const

/**
 * Names of what a connector's setup creates in the customer's Google Cloud project.
 * Derived from the connector id alone, so a caller can never pick them: one connector's metrics
 * account is not the one another organization's connector impersonates. 24 hex characters keep
 * the service account id at Google's 30-character limit.
 */
export const gcpConnectorResourceNames = (connectorId: GcpConnectorId) => {
	const hex = connectorId.replaceAll("-", "")
	const name = `maple-${hex.slice(0, 24)}`
	return {
		serviceAccountId: name,
		topic: name,
		subscription: name,
		sink: name,
		// What a console or code setup's subscription signs its pushes as; it holds no role. The
		// ingest gateway also checks the host project and an audience naming the connector in full.
		pushServiceAccountId: `maple-push-${hex.slice(0, 19)}`,
	}
}

export const gcpServiceAccountEmail = (accountId: string, projectId: string) =>
	`${accountId}@${projectId}.iam.gserviceaccount.com`

export interface GcpSetupPlanInput {
	readonly connectorId: GcpConnectorId
	readonly scopeType: GcpScopeType
	/** The project ID, or the numeric folder or organization ID. */
	readonly scopeId: string
	/** The host project. */
	readonly projectId: string
	/** The receiver URL without a secret: the push tokens' audience. */
	readonly pushEndpoint: string
	/** Maple's own Google service account. Undefined: no read-only access is set up. */
	readonly mapleServiceAccountEmail: string | undefined
	readonly logsEnabled: boolean
	readonly metricsEnabled: boolean
	readonly logFilter: string
}

export type GcpSetupPlan = ReturnType<typeof gcpSetupPlan>

/**
 * What a console or code setup creates: the setup script's resources under the same names, except
 * that Pub/Sub signs each push as a push service account. The console steps, Terraform and Alchemy
 * all render from this.
 */
export const gcpSetupPlan = (input: GcpSetupPlanInput) => {
	const names = gcpConnectorResourceNames(input.connectorId)
	const reader =
		input.metricsEnabled && input.mapleServiceAccountEmail !== undefined
			? {
					serviceAccountId: names.serviceAccountId,
					serviceAccountEmail: gcpServiceAccountEmail(names.serviceAccountId, input.projectId),
					mapleServiceAccountEmail: input.mapleServiceAccountEmail,
				}
			: null
	const logs = input.logsEnabled
		? {
				topic: names.topic,
				subscription: names.subscription,
				sink: names.sink,
				sinkDestination: `pubsub.googleapis.com/projects/${input.projectId}/topics/${names.topic}`,
				logFilter: input.logFilter,
				pushEndpoint: input.pushEndpoint,
				pushServiceAccountId: names.pushServiceAccountId,
				pushServiceAccountEmail: gcpServiceAccountEmail(names.pushServiceAccountId, input.projectId),
			}
		: null
	return {
		scopeType: input.scopeType,
		scopeId: input.scopeId,
		projectId: input.projectId,
		// The push service account needs the IAM API on top of the script's log APIs.
		apis: [
			...new Set([
				...(logs === null ? [] : [...GCP_LOG_APIS, "iam.googleapis.com"]),
				...(reader === null ? [] : GCP_METRIC_APIS),
			]),
		].sort(),
		logs,
		reader,
	}
}
