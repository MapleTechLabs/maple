import {
	cloudFindingConsoleUrl,
	cloudResourceCandidates,
	cloudResourceMatchTag,
	type CloudResourceCandidate,
	CloudFindingSource,
} from "@maple/domain/cloud-security"
import {
	type CloudFinding,
	type CloudFindingAffectedService,
	type CloudFindingDetailQuery,
	type CloudFindingDetailResponse,
	CloudFindingNotFoundError,
	type CloudFindingsListRequest,
	type CloudFindingsListResponse,
	type CloudSecurityConnectionModule,
	CloudSecurityDisabledError,
	type CloudSecurityOverviewResponse,
	CloudSecurityPersistenceError,
	type IntegrationsPersistenceError,
	type TenantContext,
} from "@maple/domain/http"
import type { CloudSecurityFindingRow } from "@maple/db/tables"
import type { OrgId } from "@maple/primitives"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Order, Schema } from "effect"

import { AwsConnectionService } from "@maple/backend/services/integrations/AwsConnectionService"
import { GcpConnectorService } from "@maple/backend/services/integrations/GcpConnectorService"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { CloudSecurityStore } from "./CloudSecurityStore"

const isFindingSource = Schema.is(CloudFindingSource)

// The Security hub's Cloud tab: the store's findings, each matched to the services whose telemetry
// carried its resource, behind the `cloudSecurity` rollout.

const DEFAULT_PAGE_LIMIT = 50
/** How far back the telemetry match looks. */
export const TELEMETRY_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000

/** One matched (attribute, value, service) the warehouse answered with. */
export interface ResourceServiceMatch {
	/** The matched candidate, as `cloudResourceMatchTag` names it. */
	readonly match: string
	readonly service: string
	readonly requests: number
}

const NO_MATCHES: ReadonlyArray<ResourceServiceMatch> = []

interface FindingResource {
	readonly resourceId: string
	readonly resourceType: string
	readonly accountId: string
	readonly region: string
}

/** The services one resource affects, busiest first, each counted once across the values it may carry. */
export const affectedServicesOf = (
	resource: FindingResource,
	matches: ReadonlyArray<ResourceServiceMatch>,
): ReadonlyArray<CloudFindingAffectedService> => {
	// On attribute, scope and value together: a Lambda named `prod` is not the `prod` cluster, nor
	// the `prod` function of another account.
	const candidates = new Set(Arr.map(cloudResourceCandidates(resource), cloudResourceMatchTag))
	// One span can carry several of a finding's candidates (a Lambda's ARN and its name), so a
	// service counts the most any one of them saw, not their sum.
	const totals = Arr.reduce(
		Arr.filter(matches, (match) => candidates.has(match.match)),
		new Map<string, number>(),
		(acc, match) => acc.set(match.service, Math.max(acc.get(match.service) ?? 0, match.requests)),
	)
	return Arr.sort(
		Arr.map([...totals], ([service, requests]) => ({ service, requests })),
		Order.mapInput(Order.flip(Order.Number), (entry: CloudFindingAffectedService) => entry.requests),
	)
}

const toPersistenceError = (error: IntegrationsPersistenceError) =>
	new CloudSecurityPersistenceError({
		message: "Cloud findings are temporarily unavailable",
		cause: error._tag,
	})

const toFinding = (
	row: CloudSecurityFindingRow,
	matches: ReadonlyArray<ResourceServiceMatch>,
): CloudFinding => ({
	provider: row.provider,
	connectionId: row.connectionId,
	accountId: row.accountId,
	region: row.region,
	source: row.source,
	findingId: row.findingId,
	type: row.type,
	title: row.title,
	description: row.description,
	severity: row.severity,
	status: row.status,
	resourceType: row.resourceType,
	resourceId: row.resourceId,
	resourceName: row.resourceName,
	occurrences: row.occurrences,
	firstSeenAt: row.firstSeenAt,
	lastSeenAt: row.lastSeenAt,
	syncedAt: row.syncedAt,
	consoleUrl: cloudFindingConsoleUrl(row),
	affectedServices: affectedServicesOf(row, matches),
})

export interface CloudSecurityReadServiceApi {
	readonly overview: (
		tenant: TenantContext,
	) => Effect.Effect<
		CloudSecurityOverviewResponse,
		CloudSecurityDisabledError | CloudSecurityPersistenceError
	>
	readonly listFindings: (
		tenant: TenantContext,
		request: CloudFindingsListRequest,
	) => Effect.Effect<CloudFindingsListResponse, CloudSecurityDisabledError | CloudSecurityPersistenceError>
	readonly finding: (
		tenant: TenantContext,
		query: CloudFindingDetailQuery,
	) => Effect.Effect<
		CloudFindingDetailResponse,
		CloudSecurityDisabledError | CloudSecurityPersistenceError | CloudFindingNotFoundError
	>
}

export class CloudSecurityReadService extends Context.Service<
	CloudSecurityReadService,
	CloudSecurityReadServiceApi
>()("@maple/backend/services/CloudSecurityReadService", {
	make: Effect.gen(function* () {
		const store = yield* CloudSecurityStore
		const connections = yield* AwsConnectionService
		const gcpConnectors = yield* GcpConnectorService
		const featureFlags = yield* OrganizationFeatureFlagsService
		const warehouse = yield* WarehouseQueryService

		const requireRollout = Effect.fn("CloudSecurityReadService.requireRollout")(function* (orgId: OrgId) {
			const flags = yield* featureFlags.flags(orgId)
			if (!flags.cloudSecurity) {
				return yield* new CloudSecurityDisabledError({
					message: "Cloud security is not enabled for this organization.",
				})
			}
		})

		/** The services carrying each resource; none, flagged unmatched, when the warehouse fails. */
		const matchTelemetry = Effect.fn("CloudSecurityReadService.matchTelemetry")(function* (
			tenant: TenantContext,
			resources: ReadonlyArray<FindingResource>,
		) {
			const all: ReadonlyArray<CloudResourceCandidate> = Arr.flatMap(resources, cloudResourceCandidates)
			// The query groups by attribute, scope and value: dedupe on all three, as its match tag names them.
			const ids = Arr.dedupeWith(all, (a, b) => cloudResourceMatchTag(a) === cloudResourceMatchTag(b))
			if (!Arr.isReadonlyArrayNonEmpty(ids)) {
				return { matches: NO_MATCHES, matched: true }
			}
			const now = yield* Clock.currentTimeMillis
			const rows = yield* warehouse
				.compiledQuery(
					tenant,
					CH.compile(
						CH.cloudResourceServicesQuery({ candidates: ids }),
						{
							orgId: tenant.orgId,
							startTime: formatWarehouseDateTime(now - TELEMETRY_MATCH_WINDOW_MS),
							endTime: formatWarehouseDateTime(now),
						},
						{ rowSchema: CH.cloudResourceServicesRowSchema },
					),
					{ profile: "list", context: "cloudResourceServices" },
				)
				.pipe(
					// The list still loads without it; the log says why it says "not checked".
					Effect.tapError((error) =>
						Effect.logWarning("Cloud findings telemetry match failed").pipe(
							Effect.annotateLogs({ error: error.message, candidates: ids.length }),
						),
					),
					Effect.option,
				)
			yield* Effect.annotateCurrentSpan("maple.cloud_security.telemetry_matched", Option.isSome(rows))
			return Option.match(rows, {
				onNone: () => ({ matches: NO_MATCHES, matched: false }),
				// Past the cap some resource may have lost its services: show what came, flagged unmatched.
				onSome: (matches): { matches: ReadonlyArray<ResourceServiceMatch>; matched: boolean } => ({
					matches: Arr.take(matches, CH.CLOUD_RESOURCE_SERVICES_MAX_ROWS),
					matched: matches.length <= CH.CLOUD_RESOURCE_SERVICES_MAX_ROWS,
				}),
			})
		})

		const overview = Effect.fn("CloudSecurityReadService.overview")(function* (tenant: TenantContext) {
			yield* requireRollout(tenant.orgId)
			const [status, gcpStatus, summary, states] = yield* Effect.all(
				[
					connections.status(tenant.orgId),
					gcpConnectors.status(tenant.orgId),
					store.summary(tenant.orgId),
					store.orgServiceStates(tenant.orgId),
				],
				{ concurrency: "unbounded" },
			).pipe(Effect.mapError(toPersistenceError))
			const accountOf = new Map<string, string>([
				...Arr.map(status.connections, (c) => [c.id, c.accountId] as const),
				...Arr.map(gcpStatus.connectors, (c) => [c.id, c.scopeId] as const),
			])
			// A GCP connector's access is in place once a poll could read SCC with it.
			const sccReadable = new Set(
				Arr.flatMap(states, (state) =>
					state.provider === "gcp" && state.state === "enabled" ? [state.connectionId] : [],
				),
			)
			const gcpConnections = Arr.map(gcpStatus.connectors, (connector) => {
				const module: CloudSecurityConnectionModule = !connector.securityEnabled
					? "not_requested"
					: sccReadable.has(connector.id)
						? "granted"
						: "requested"
				return {
					provider: "gcp" as const,
					connectionId: connector.id,
					accountId: connector.scopeId,
					module,
				}
			})
			return {
				connections: Arr.appendAll(
					Arr.map(status.connections, (connection) => {
						const module: CloudSecurityConnectionModule = !Arr.contains(
							connection.modules,
							"security",
						)
							? "not_requested"
							: connection.grantedModules !== null &&
								  Arr.contains(connection.grantedModules, "security")
								? "granted"
								: "requested"
						return {
							provider: "aws" as const,
							connectionId: connection.id,
							accountId: connection.accountId,
							module,
						}
					}),
					gcpConnections,
				),
				summary,
				// CloudTrail's state belongs to the audit log's sources, not to the findings page.
				services: Arr.flatMap(states, (state) => {
					const accountId = accountOf.get(state.connectionId)
					const source = state.source
					return accountId === undefined || !isFindingSource(source)
						? []
						: [
								{
									provider: state.provider,
									connectionId: state.connectionId,
									accountId,
									region: state.region,
									source,
									state: state.state,
									lastError: state.lastError,
									checkedAt: state.checkedAt,
									pushedAt: state.pushedAt,
								},
							]
				}),
			} satisfies CloudSecurityOverviewResponse
		})

		const listFindings = Effect.fn("CloudSecurityReadService.listFindings")(function* (
			tenant: TenantContext,
			request: CloudFindingsListRequest,
		) {
			yield* requireRollout(tenant.orgId)
			const limit = request.limit ?? DEFAULT_PAGE_LIMIT
			const offset = request.offset ?? 0
			const page = yield* store
				.listFindings(
					tenant.orgId,
					{
						status: request.status ?? "active",
						severities: request.severities,
						sources: request.sources,
						providers: request.providers,
						accountId: request.accountId,
						region: request.region,
						search: request.search,
					},
					{ limit, offset },
				)
				.pipe(Effect.mapError(toPersistenceError))
			const telemetry = yield* matchTelemetry(tenant, page.rows)
			return {
				findings: Arr.map(page.rows, (row) => toFinding(row, telemetry.matches)),
				nextOffset: page.hasMore ? offset + page.rows.length : null,
				telemetryMatched: telemetry.matched,
			} satisfies CloudFindingsListResponse
		})

		const finding = Effect.fn("CloudSecurityReadService.finding")(function* (
			tenant: TenantContext,
			query: CloudFindingDetailQuery,
		) {
			yield* requireRollout(tenant.orgId)
			const row = yield* store.getFinding(tenant.orgId, query).pipe(
				Effect.mapError(toPersistenceError),
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.fail(new CloudFindingNotFoundError({ message: "No such finding." })),
						onSome: Effect.succeed,
					}),
				),
			)
			const telemetry = yield* matchTelemetry(tenant, [row])
			return {
				finding: { ...toFinding(row, telemetry.matches), detail: row.detail },
				telemetryMatched: telemetry.matched,
			} satisfies CloudFindingDetailResponse
		})

		return { overview, listFindings, finding } satisfies CloudSecurityReadServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide([
			CloudSecurityStore.layer,
			AwsConnectionService.layer,
			GcpConnectorService.layer,
			OrganizationFeatureFlagsService.layer,
			WarehouseQueryService.layer,
		]),
	)
}
