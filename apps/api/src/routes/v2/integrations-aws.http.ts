import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant } from "@maple/domain/http"
import type { V2AwsConnection } from "@maple/domain/http/v2"
import {
	MapleApiV2,
	isoTimestamp,
	isoTimestampOrNull,
	V2InsufficientPermissions,
} from "@maple/domain/http/v2"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import {
	AwsConnectionService,
	type AwsConnection,
} from "@maple/backend/services/integrations/AwsConnectionService"
import { AwsIngestService } from "@maple/backend/services/integrations/AwsIngestService"

// Reading the status is open to every member. Everything else is admin-only: a connection decides
// what Maple may read in the org's AWS account.
const adminOnly = () => V2InsufficientPermissions.make("Only org admins can manage AWS connections")

const toV2Connection = (connection: AwsConnection): V2AwsConnection => ({
	id: connection.id,
	object: "aws_connection",
	account_id: connection.accountId,
	role_arn: connection.roleArn,
	oidc_issuer: connection.oidcIssuer,
	oidc_subject: connection.oidcSubject,
	modules: connection.modules,
	granted_modules: connection.grantedModules,
	template_version: connection.templateVersion,
	setup_outdated: connection.setupOutdated,
	verified_at: isoTimestampOrNull(connection.verifiedAt),
	last_checked_at: isoTimestampOrNull(connection.lastCheckedAt),
	last_check_error: connection.lastCheckError,
	metric_stream: connection.metricStream,
	metrics_last_received_at: isoTimestampOrNull(connection.metricsLastReceivedAt),
	metrics_last_error: connection.metricsLastError,
	created_at: isoTimestamp(connection.createdAt),
})

const auditMetadata = (connection: AwsConnection) => ({
	account_id: connection.accountId,
	modules: connection.modules,
	metric_stream: connection.metricStream,
})

export const HttpV2AwsIntegrationsLive = HttpApiBuilder.group(MapleApiV2, "awsIntegration", (handlers) =>
	Effect.gen(function* () {
		const aws = yield* AwsConnectionService
		const awsIngest = yield* AwsIngestService

		return handlers
			.handle("status", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* aws.status(tenant.orgId)
					return {
						object: "aws_integration" as const,
						available: status.available,
						modules: status.modules,
						connections: status.connections.map(toV2Connection),
					}
				}),
			)
			.handle("createConnection", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly)
					const connection = yield* aws.create(tenant.orgId, tenant.userId, {
						accountId: payload.account_id,
						modules: payload.modules ?? [],
						metricStream: payload.metric_stream ?? null,
					})
					yield* recordHttpAudit("aws_connection.created", {
						resourceId: connection.id,
						metadata: auditMetadata(connection),
					})
					return toV2Connection(connection)
				}),
			)
			.handle("updateConnection", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly)
					const connection = yield* aws.update(tenant.orgId, params.id, {
						modules: payload.modules,
						metricStream: payload.metric_stream,
					})
					yield* recordHttpAudit("aws_connection.updated", {
						resourceId: connection.id,
						metadata: auditMetadata(connection),
					})
					return toV2Connection(connection)
				}),
			)
			.handle("setup", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly)
					const setup = yield* aws.setup(tenant.orgId, params.id)
					return {
						object: "aws_connection.setup" as const,
						stack_name: setup.stackName,
						stack_region: setup.stackRegion,
						setup_script: setup.setupScript,
						cleanup_script: setup.cleanupScript,
						cloudformation_template: setup.cloudformationTemplate,
						terraform: setup.terraform,
						metrics_stack_name: setup.metricsStackName,
						metrics_cloudformation_template: setup.metricsCloudformationTemplate,
					}
				}),
			)
			.handle("checkConnection", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly)
					return toV2Connection(yield* aws.check(tenant.orgId, params.id))
				}),
			)
			.handle("ingest", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const ingest = yield* awsIngest.read(tenant, params.id)
					return {
						object: "aws_connection.ingest" as const,
						window_start: isoTimestamp(ingest.windowStart),
						window_end: isoTimestamp(ingest.windowEnd),
						data_points: ingest.dataPoints,
						last_point_at: isoTimestampOrNull(ingest.lastPointAt),
						groups: ingest.groups.map((group) => ({
							namespace: group.namespace,
							region: group.region,
							metrics: group.metrics,
							data_points: group.dataPoints,
							resources: group.resources,
							sample_resources: group.sampleResources,
							last_point_at: isoTimestamp(group.lastPointAt),
						})),
					}
				}),
			)
			.handle("deleteConnection", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly)
					const deleted = yield* aws.delete(tenant.orgId, params.id)
					yield* recordHttpAudit("aws_connection.deleted", {
						resourceId: params.id,
						metadata: auditMetadata(deleted.connection),
					})
					return {
						id: params.id,
						object: "aws_connection" as const,
						deleted: true as const,
						cleanup_script: deleted.cleanupScript,
					}
				}),
			)
	}),
)
