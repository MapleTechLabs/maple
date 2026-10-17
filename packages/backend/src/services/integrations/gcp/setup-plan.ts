import { GCP_READER_PROJECT_ROLE, GCP_READER_SCOPE_ROLES, gcpConnectorResourceNames } from "@maple/domain/gcp"
import type { GcpConnectorId, GcpLogRuntime, GcpProjectId } from "@maple/domain/primitives"
import { gcpLogFilter, LOG_APIS, METRIC_APIS, type GcpScriptTarget } from "./setup-scripts"

/** How the push subscription delivers: the setup script's flags, in numbers. */
export const GCP_PUSH_SUBSCRIPTION = {
	ackDeadlineSeconds: 30,
	messageRetentionSeconds: 86_400,
	minRetryDelaySeconds: 10,
	maxRetryDelaySeconds: 600,
} as const

export interface GcpSetupPlanInput extends Omit<GcpScriptTarget, "mapleUrl"> {
	/** The receiver URL without a secret: the push tokens' audience. */
	readonly pushEndpoint: string
	/** Maple's own Google service account. Undefined: no read-only access is set up. */
	readonly mapleServiceAccountEmail: string | undefined
	readonly logsEnabled: boolean
	readonly metricsEnabled: boolean
	/** Without a script there is no filter to keep: null is the filter a new sink gets. */
	readonly applicationLogs: ReadonlyArray<GcpLogRuntime> | null
}

export type GcpSetupPlan = ReturnType<typeof gcpSetupPlan>
export type GcpReaderPlan = ReturnType<typeof gcpReaderPlan>

const serviceAccountEmail = (accountId: string, projectId: GcpProjectId) =>
	`${accountId}@${projectId}.iam.gserviceaccount.com`

/** The read-only account Maple reads metrics and resources as, and what it is granted. */
export const gcpReaderPlan = (
	connectorId: GcpConnectorId,
	projectId: GcpProjectId,
	mapleServiceAccountEmail: string,
) => {
	const { serviceAccountId } = gcpConnectorResourceNames(connectorId)
	return {
		serviceAccountId,
		serviceAccountEmail: serviceAccountEmail(serviceAccountId, projectId),
		mapleServiceAccountEmail,
		scopeRoles: GCP_READER_SCOPE_ROLES,
		projectRoles: [GCP_READER_PROJECT_ROLE],
	}
}

/**
 * What a console or infrastructure-as-code setup creates: the setup script's resources under the
 * same names, except that Pub/Sub signs each push as a push service account instead of the
 * endpoint carrying a secret. The manual steps, Terraform and Alchemy all render from this.
 */
export const gcpSetupPlan = (input: GcpSetupPlanInput) => {
	const names = gcpConnectorResourceNames(input.connectorId)
	const reader =
		input.metricsEnabled && input.mapleServiceAccountEmail !== undefined
			? gcpReaderPlan(input.connectorId, input.projectId, input.mapleServiceAccountEmail)
			: null
	const logs = input.logsEnabled
		? {
				topic: names.topic,
				subscription: names.subscription,
				sink: names.sink,
				sinkDestination: `pubsub.googleapis.com/projects/${input.projectId}/topics/${names.topic}`,
				logFilter: gcpLogFilter(input.applicationLogs ?? []),
				// A folder or organization sink also routes the logs of every project underneath.
				includeChildren: input.scopeType !== "project",
				pushEndpoint: input.pushEndpoint,
				pushServiceAccountId: names.pushServiceAccountId,
				pushServiceAccountEmail: serviceAccountEmail(names.pushServiceAccountId, input.projectId),
				...GCP_PUSH_SUBSCRIPTION,
			}
		: null
	return {
		scopeType: input.scopeType,
		scopeId: input.scopeId,
		projectId: input.projectId,
		// The push service account needs the IAM API on top of the script's log APIs.
		apis: [
			...new Set([
				...(logs === null ? [] : [...LOG_APIS, "iam.googleapis.com"]),
				...(reader === null ? [] : METRIC_APIS),
			]),
		].sort(),
		logs,
		reader,
	}
}
