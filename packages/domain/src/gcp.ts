import type { GcpConnectorId, GcpScopeType } from "@maple/primitives"
import { Schema, String as Str } from "effect"

/** The read-only account's roles: on the scope, and on the host project its reads are billed to. */
export const GCP_READER_SCOPE_ROLES = ["roles/monitoring.viewer", "roles/cloudasset.viewer"]
export const GCP_READER_PROJECT_ROLE = "roles/serviceusage.serviceUsageConsumer"

/** What the reader also holds on the scope when security findings are on. */
export const GCP_SECURITY_SCOPE_ROLE = "roles/securitycenter.findingsViewer"

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

/** Security Command Center, on top of the reader's APIs and Pub/Sub for its notifications. */
export const GCP_SECURITY_APIS = [
	"securitycenter.googleapis.com",
	"pubsub.googleapis.com",
	"iam.googleapis.com",
	"iamcredentials.googleapis.com",
	"cloudresourcemanager.googleapis.com",
]

/**
 * Which findings the notification config sends: every finding written or changed in scope. Muted
 * and closed ones too, so Maple sees a finding leave as it happens.
 */
export const GCP_SECURITY_NOTIFICATION_FILTER = 'state="ACTIVE" OR state="INACTIVE"'

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
	const hex = Str.replaceAll("-", "")(connectorId)
	const name = `maple-${Str.slice(0, 24)(hex)}`
	return {
		serviceAccountId: name,
		topic: name,
		subscription: name,
		sink: name,
		// What a console or code setup's subscription signs its pushes as; it holds no role. The
		// ingest gateway also checks the host project and an audience naming the connector in full.
		pushServiceAccountId: `maple-push-${Str.slice(0, 19)(hex)}`,
		// Security Command Center's notifications ride a topic of their own, pushed to the API.
		securityTopic: `${name}-scc`,
		securitySubscription: `${name}-scc`,
		notificationConfig: name,
	}
}

/** The scope as Security Command Center names a parent: `projects/acme`, `folders/123`, `organizations/123`. */
export const gcpScopeParent = (scopeType: GcpScopeType, scopeId: string): string =>
	`${scopeType === "project" ? "projects" : scopeType === "folder" ? "folders" : "organizations"}/${scopeId}`

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
	readonly securityEnabled: boolean
	readonly logFilter: string
	/** The API's receiver for Security Command Center notifications: the pushes' audience. */
	readonly securityPushEndpoint: string
}

export type GcpSetupPlan = ReturnType<typeof gcpSetupPlan>

/**
 * What a console or code setup creates: the setup script's resources under the same names, except
 * that Pub/Sub signs each push as a push service account. The console steps, Terraform and Alchemy
 * all render from this.
 */
export const gcpSetupPlan = (input: GcpSetupPlanInput) => {
	const names = gcpConnectorResourceNames(input.connectorId)
	const reads = input.metricsEnabled || input.securityEnabled
	const reader =
		reads && input.mapleServiceAccountEmail !== undefined
			? {
					serviceAccountId: names.serviceAccountId,
					serviceAccountEmail: gcpServiceAccountEmail(names.serviceAccountId, input.projectId),
					mapleServiceAccountEmail: input.mapleServiceAccountEmail,
					// Roles on the scope: what metrics and resources need, and SCC's viewer for findings.
					scopeRoles: [
						...(input.metricsEnabled ? GCP_READER_SCOPE_ROLES : []),
						...(input.securityEnabled ? [GCP_SECURITY_SCOPE_ROLE] : []),
					],
				}
			: null
	const pushServiceAccountEmail = gcpServiceAccountEmail(names.pushServiceAccountId, input.projectId)
	// Findings are read by the reader, so security needs Maple's identity as metrics does.
	const security =
		input.securityEnabled && reader !== null
			? {
					parent: gcpScopeParent(input.scopeType, input.scopeId),
					notificationConfig: names.notificationConfig,
					topic: names.securityTopic,
					subscription: names.securitySubscription,
					filter: GCP_SECURITY_NOTIFICATION_FILTER,
					pushEndpoint: input.securityPushEndpoint,
					pushServiceAccountId: names.pushServiceAccountId,
					pushServiceAccountEmail,
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
				pushServiceAccountEmail,
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
				...(reader === null || !input.metricsEnabled ? [] : GCP_METRIC_APIS),
				...(security === null ? [] : GCP_SECURITY_APIS),
			]),
		].sort(),
		logs,
		reader,
		security,
	}
}

/** A Cloud SQL instance's settings, read off its Cloud Asset Inventory resource. */
export const GcpCloudSqlSettings = Schema.Struct({
	/** `POSTGRES_15`, `MYSQL_8_0`, `SQLSERVER_2022_STANDARD`, ... */
	databaseVersion: Schema.NullOr(Schema.String),
	/** `ENTERPRISE` or `ENTERPRISE_PLUS`. */
	edition: Schema.NullOr(Schema.String),
	tier: Schema.NullOr(Schema.String),
	/** Read off the tier; null for a tier Maple does not know. */
	cpus: Schema.NullOr(Schema.Finite),
	memoryGb: Schema.NullOr(Schema.Finite),
	/** `REGIONAL` is high availability, `ZONAL` is not. */
	availabilityType: Schema.NullOr(Schema.String),
	/** The primary of a read replica, as `<project>:<instance>`. */
	primary: Schema.NullOr(Schema.String),
	diskSizeGb: Schema.NullOr(Schema.Finite),
	queryInsightsEnabled: Schema.Boolean,
	/**
	 * The `max_connections` flag, or PostgreSQL's default for the memory of the larger of the
	 * instance and its primary. Null when neither is known.
	 */
	maxConnections: Schema.NullOr(Schema.Finite),
	maxConnectionsSource: Schema.NullOr(Schema.Literals(["flag", "default"])),
})
export type GcpCloudSqlSettings = Schema.Schema.Type<typeof GcpCloudSqlSettings>
