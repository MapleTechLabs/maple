import * as Clerk from "@distilled.cloud/clerk"
import * as Policy from "@maple/domain/policy"
import { ownBillingCustomer } from "@maple/backend/services/billing/billing-customer"
import {
	ChooseOrganizationRegionResponse,
	CreateOrganizationResponse,
	OrganizationForbiddenError,
	OrganizationProviderError,
	OrganizationRegionLockedError,
	OrgId,
	type UserId,
} from "@maple/domain/http"
import {
	type MapleRegion,
	organizationHomeRegion,
	organizationRegionChosen,
	organizationRegionMetadata,
	organizationRegionOpen,
} from "@maple/domain/organization-regions"
import * as Tables from "@maple/db/tables"
import type { ColumnDefs, PgSchemaTable } from "@maple-dev/effect-orm/postgres"
import { Clock, Context, Effect, Layer, Option, Order, Schema, Array as Arr, Record as Rec } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { responseHasPlanHistory } from "@maple/backend/services/billing/autumn-client"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import { type ClerkApi, clerkModeApi } from "@maple/auth"

const toProviderError = (error: unknown) =>
	new OrganizationProviderError({
		message: error instanceof Error ? error.message : "Organization provider call failed",
	})

type AnyTable = PgSchemaTable<string, ColumnDefs>
type TableName = keyof typeof Tables

/**
 * The order `OrganizationDeletionService.delete` purges tables in; a row another org-scoped row
 * references goes after it. Org-scoped tables not named here are purged after these, so a new one
 * is never left behind.
 */
const PURGE_ORDER: ReadonlyArray<TableName> = [
	"AgentFeedback",
	"DashboardVersions",
	"Dashboards",
	"AlertDeliveryEvents",
	// Before its incident: an event row references it.
	"AlertIncidentEvents",
	"AlertEscalationRuns",
	"AlertMemberNotifications",
	"AlertIncidents",
	"EscalationChains",
	// Before its schedule: an override row references it.
	"OnCallOverrides",
	"OnCallSchedules",
	"AlertRuleStates",
	"AlertRules",
	"AlertSilences",
	"AlertMaintenanceWindows",
	// Before its destination: a thread row references it.
	"AlertLinearIssues",
	"AlertDestinations",
	"ApiKeys",
	"CancellationReviews",
	"OrgIngestKeys",
	"Sources",
	// Before its source: a catalog entry references it.
	"ExternalDataSourceCatalogEntries",
	"ExternalDataSources",
	"OrgClickHouseSettings",
	"ScrapeTargets",
	// Status pages first: their components point at monitors. The edge copy of a page outlives
	// these rows until the publisher's sweep removes pages it no longer finds.
	"StatusPageIncidentComponents",
	"StatusPageIncidentUpdates",
	"StatusPageIncidents",
	"StatusPageComponents",
	// Its Cloudflare hostname and route were queued for removal with the pages above.
	"StatusPageCustomDomains",
	"StatusPages",
	// A surviving monitor keeps Maple probing the org's endpoints, and its heartbeat token
	// keeps accepting pings. The state rows also go with the monitor by foreign key.
	"UptimeMonitorDaily",
	"UptimeMonitorStates",
	"UptimeMonitors",
	// An SLO points at its burn-rate rule, which goes with the org's alert rules.
	"Slos",
	// Picked Search Console properties; a surviving row would keep importing the org's search data.
	"SearchConsoleSites",
	"OAuthConnections",
	"OAuthAuthStates",
	// The binding that makes a chat workspace's members act as the org. Deleting
	// the org must stop the bot answering there, and nothing else would.
	"ChatWorkspaces",
	// Each row lets one chat account approve changes as one Maple user. Deleting the org must
	// end that standing authority, not leave it pointed at an org that is gone.
	"ChatIdentities",
	"DigestSubscriptions",
	"CloudflareLogpushConnectors",
	// A surviving push secret would keep the ingest gateway accepting logs for a deleted org.
	"GcpConnectors",
	// Also removed with its connector, by the foreign key.
	"GcpResources",
	// Before the connections they point at: a surviving row would keep the cost sync pulling.
	"CostSources",
	// Also removed with their connection, by the foreign key.
	"CloudSecurityFindings",
	"CloudSecurityServiceStates",
	// A surviving row would keep Maple signing tokens for, and assuming, the customer's role.
	"AwsConnections",
	"ErrorIssueEvents",
	"ErrorIssueStates",
	"ErrorIncidents",
	// The aliases go with the issues they point at, and the keys that grouped them.
	"ErrorIssueFingerprints",
	"ErrorGroupingKeys",
	// A `waiting` row left behind is due work: the verification tick scans every org's and
	// would pick it up on each run, for an issue that is purged below.
	"ErrorIssueVerifications",
	"ErrorIssues",
	"ErrorNotificationPolicies",
	"ErrorGroupingConfigs",
	"Actors",
	"VcsInstallations",
	"VcsRepositories",
	"VcsCommits",
	"PrReviews",
	"PrReviewSettings",
	"PrReviewFindings",
	"PrReviewFindingEmbeddings",
	"PrReviewMergeSteps",
	"PrReviewReplies",
	"PrReviewEdits",
	// Credentials that outlive the org unless they are purged here. `api_keys`
	// alone was not enough: an MCP grant's refresh family re-mints its key
	// hourly, so a deleted org's MCP client kept working for up to 30 days.
	"McpOAuthRefreshTokens",
	"MobileDevices",
	// Device-held widget keys: their tokens re-read the row, so deleting it ends them.
	"DeviceCredentials",
	// A share link is a public bearer credential: `resolveByToken` matches the
	// token hash and `revoked_at is null` and nothing else, then queries the
	// warehouse as the org. It only went dead on deletion by accident of a
	// downstream `dashboards` lookup, which is not a guarantee.
	"DashboardShares",
	// Holds the encrypted per-connection webhook HMAC secret — standing
	// authority to have inbound writes attributed to an org that is gone.
	"PlanetscaleConnections",
	// Text derived from the org's telemetry: diagnoses, notification payloads, database events.
	// Their chat sessions are queued for erasure first (`queueOrgErasures`).
	"Investigations",
	"ErrorNotificationDeliveries",
	"PlanetscaleEvents",
	// Dedupe receipts for the org's error issues, which are purged above; with the
	// connection gone no redelivery can arrive for them to catch.
	"PlanetscaleIssueReceipts",
	// The encrypted Fleet token would keep the poller reading a device server for a deleted org.
	"FleetConnections",
	// What the org's device sources reported about its devices.
	"DevicePolicyFindings",
	"DeviceVulnerabilityFindings",
	// The encrypted Railway token would keep the poller reading an account for a deleted org.
	"RailwayConnections",
	"RailwayEnvironments",
	// The encrypted Vercel token, and the team inventory read with it.
	"VercelConnections",
	"VercelProjects",
	"VercelDeployments",
	// The Supabase grant itself is in oauth_connections; these hold the org binding and projects.
	"SupabaseProjectInsights",
	"SupabaseProjects",
	"SupabaseConnections",
	// The org's own OpenRouter key: a recreated org with the same id must not inherit it.
	"OrgOpenRouterKeys",
	// Enterprise SSO domains, connection ids and SCIM groups. The Clerk connection and directory
	// are deleted before the purge; the organization domains go with the Clerk org.
	"OrgSsoDomains",
	"OrgSsoConnections",
	"OrgDirectoryGroups",
	// A surviving key would keep Maple reading the deleted org's OpenRouter spend.
	"OpenRouterCostConnections",
	// The same for every provider read with a pasted credential.
	"CostConnections",
	// What the org's members asked Maple to support, and who asked.
	"FeatureRequests",
	// A deleted member org stops being billed to anyone. A billing org with members is refused.
	"OrgBillingLinks",
	// Drop rules and the hash salt: a recreated org must not silently lose data to old rules.
	"OrgIngestRules",
	"OrgIngestRuleSettings",
	"OrgIngestRuleStats",
	// APNs update tokens for running Live Activities. `mobile_devices` is purged
	// here already; leaving these behind keeps a live push channel open.
	"LiveActivities",
	// Nothing secret, but the channel belongs to the org; a recreated org starts fresh.
	"OrgSupportChannels",
	// Security audit evidence about the org's source code: exploit traces must not outlive the org.
	"SecurityAuditEvents",
	"SecurityAuditOrgReservations",
	"SecurityAuditOrgSettings",
	"SecurityAuditRunFindings",
	"SecurityAuditFindings",
	"SecurityAuditUnits",
	"SecurityAuditRuns",
	"SecurityAuditTargets",
	// The team's hand-built service map world: a recreated org starts from an empty map.
	"ServiceMapWorldEntities",
	// Which of the org's dependencies are vulnerable, per repository and commit.
	"DependencyScans",
	"DependencyScanMatches",
	"DependencyFindings",
	// Same purge, different column: these record an *approval* rather than ownership.
	"McpOAuthAuthorizations",
	"CliDeviceAuthorizations",
]

/**
 * Org-scoped tables deliberately left behind by the deletion; every other table with an `org_id` or
 * `approved_org_id` is purged.
 *
 * Every name below has been read against its schema: none holds a token, hash,
 * ciphertext or other secret, and none is resolved by anything to grant access.
 * They are analytics, settings and history: retained data, which is a
 * retention question and a defensible follow-up, not a live-credential gap.
 * The three that failed that read (`dashboardShares`, `planetscaleConnections`,
 * `liveActivities`) are purged rather than excused here.
 */
export const UNPURGED_ORG_SCOPED_TABLES = [
	"AiTriageSettings",
	"AlertRuleClaims",
	"AnomalyDetectorSettings",
	"AnomalyDetectorStates",
	"AnomalyIncidents",
	"CloudflareAnalyticsState",
	"CloudflareFeatureSettings",
	"CloudflareHyperdriveConfigs",
	"CloudflareZoneSettings",
	"ErrorFingerprintCandidates",
	"ErrorIssuePullRequests",
	"ErrorTickStates",
	"IssueEscalationPolicies",
	"IssueEscalations",
	"LinearFeatureSettings",
	"OrgClickHouseSchemaApplyRuns",
	"OrgIngestAttributeMappings",
	"OrgIngestSamplingPolicies",
	"OrgOnboardingState",
	"OrgRecommendationIssues",
	"PlanetscaleDatabases",
	"PlanetscalePollState",
	"ScrapeTargetChecks",
	// Edge cleanups queued by the delete itself; the publisher removes each row once done.
	"StatusPageCleanups",
	// Erasures outside Postgres queued by the delete itself; the drain removes each row once done.
	"OrgErasures",
	"VcsRepositoryBranches",
] as const satisfies ReadonlyArray<TableName>

const hasColumn = (table: AnyTable, name: string) =>
	Arr.some(table.ddl.columns, (column) => column.name === name)

/** Every exported table with the column that ties it to an org, in purge order, minus the kept ones. */
const purgedTables = (column: "org_id" | "approved_org_id"): ReadonlyArray<AnyTable> => {
	const unpurged: ReadonlySet<string> = new Set(UNPURGED_ORG_SCOPED_TABLES)
	const position = (name: string) =>
		Option.getOrElse(
			Arr.findFirstIndex(PURGE_ORDER, (ordered) => ordered === name),
			() => PURGE_ORDER.length,
		)
	const scoped = Arr.flatMap(Rec.toEntries(Tables), ([name, value]) =>
		Option.match(
			Arr.findFirst(Tables.allTables, (table) => table === value),
			{
				onNone: () => [],
				onSome: (table) =>
					hasColumn(table, column) && !unpurged.has(name) ? [[name, table] as const] : [],
			},
		),
	)
	return Arr.map(
		Arr.sort(
			scoped,
			Order.mapInput(Order.Number, ([name]: (typeof scoped)[number]) => position(name)),
		),
		([, table]) => table,
	)
}

export const ORG_DELETE_REGISTRY = {
	orgScoped: purgedTables("org_id"),
	approvedOrgScoped: purgedTables("approved_org_id"),
	unpurged: UNPURGED_ORG_SCOPED_TABLES,
	purgeOrder: PURGE_ORDER,
} as const

/** Read model for the org identity — sourced from Clerk when available. */
export interface OrganizationInfo {
	readonly id: OrgId
	readonly name: string | null
	readonly slug: string | null
	/**
	 * The org's own logo, or `null` when it never uploaded one.
	 *
	 * Clerk always hands back a URL — it generates an initials avatar when
	 * `hasImage` is false — so the flag is what separates "this is their mark"
	 * from "this is a placeholder Clerk drew". Callers that want a placeholder
	 * should draw their own rather than ship Clerk's into a Maple surface.
	 */
	readonly imageUrl: string | null
	readonly createdAtMs: number | null
}

export interface OrganizationServiceApi {
	/** Creates a Clerk organization owned by `userId`, living in `region` from the start. */
	readonly create: (
		userId: UserId,
		name: string,
		region: MapleRegion,
	) => Effect.Effect<CreateOrganizationResponse, OrganizationProviderError>
	/** Sets the region of an organization created without one, while it is still onboarding. */
	readonly chooseRegion: (
		orgId: OrgId,
		permissions: Policy.Grants,
		region: MapleRegion,
	) => Effect.Effect<
		ChooseOrganizationRegionResponse,
		OrganizationForbiddenError | OrganizationRegionLockedError | OrganizationProviderError
	>
	readonly retrieve: (orgId: OrgId) => Effect.Effect<OrganizationInfo, OrganizationProviderError>
}

/** Fails unless the caller may change the organization's settings. */
export const requireOrganizationAdmin = Effect.fn("OrganizationService.requireAdmin")(function* (
	permissions: Policy.Grants,
) {
	return yield* Policy.check(
		permissions,
		"organization:manage",
		(denial) => new OrganizationForbiddenError({ message: denial.message }),
	)
})

export class OrganizationService extends Context.Service<OrganizationService, OrganizationServiceApi>()(
	"@maple/backend/services/OrganizationService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env

			const autumn = yield* AutumnClient
			const regions = yield* OrganizationRegionService

			/** The Clerk Backend API, or `None` when not running in Clerk auth mode. */
			const clerkClient = () => Option.fromUndefinedOr(clerkModeApi(env))
			const getOrganization = (api: ClerkApi, orgId: OrgId) =>
				api.run(Clerk.getOrganization({ organization_id: orgId }))

			/**
			 * The caller's org identity. In Clerk mode it is read from Clerk; in
			 * self-hosted mode there is no directory, so name/slug/createdAt are null
			 * and only the id is meaningful.
			 */
			const retrieve = Effect.fn("OrganizationService.retrieve")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const clerk = clerkClient()
				if (Option.isNone(clerk)) {
					return {
						id: orgId,
						name: null,
						slug: null,
						imageUrl: null,
						createdAtMs: null,
					} satisfies OrganizationInfo
				}
				const org = yield* getOrganization(clerk.value, orgId).pipe(Effect.mapError(toProviderError))
				return {
					id: orgId,
					name: org.name,
					slug: org.slug,
					imageUrl: org.has_image ? (org.image_url ?? null) : null,
					createdAtMs: org.created_at,
				} satisfies OrganizationInfo
			})

			const create = Effect.fn("OrganizationService.create")(function* (
				userId: UserId,
				name: string,
				region: MapleRegion,
			) {
				yield* Effect.annotateCurrentSpan({ "tenant.userId": userId, "maple.org_region": region })
				const clerk = clerkClient()
				if (Option.isNone(clerk)) {
					return yield* new OrganizationProviderError({
						message: "Organizations can only be created in Clerk auth mode",
					})
				}
				const org = yield* clerk.value
					.run(
						Clerk.createOrganization({
							name,
							created_by: userId,
							public_metadata: organizationRegionMetadata(region),
						}),
					)
					.pipe(Effect.mapError(toProviderError))
				const orgId = yield* Schema.decodeEffect(OrgId)(org.id).pipe(
					Effect.mapError(
						() =>
							new OrganizationProviderError({
								message: "Clerk returned an invalid organization id",
							}),
					),
				)
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				return new CreateOrganizationResponse({ orgId, region })
			})

			const chooseRegion = Effect.fn("OrganizationService.chooseRegion")(function* (
				orgId: OrgId,
				permissions: Policy.Grants,
				region: MapleRegion,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.org_region": region })
				yield* requireOrganizationAdmin(permissions)
				const clerk = clerkClient()
				if (Option.isNone(clerk)) {
					return yield* new OrganizationProviderError({
						message: "Data regions can only be chosen in Clerk auth mode",
					})
				}
				const org = yield* getOrganization(clerk.value, orgId).pipe(Effect.mapError(toProviderError))
				if (organizationRegionChosen(org.public_metadata)) {
					// Choosing the region it already has is a no-op, so a retried request succeeds.
					if (organizationHomeRegion(org.public_metadata) === region) {
						return new ChooseOrganizationRegionResponse({ region })
					}
					return yield* new OrganizationRegionLockedError({
						message: "This organization's data region has already been chosen.",
					})
				}
				// An organization that predates regions has data on US already, plan or not.
				const nowMs = yield* Clock.currentTimeMillis
				if (!organizationRegionOpen(org.public_metadata, org.created_at, nowMs)) {
					return yield* new OrganizationRegionLockedError({
						message: "Only a new organization can choose its data region.",
					})
				}
				const customer = yield* autumn
					.getOrCreateCustomer(ownBillingCustomer(orgId), { expand: [] })
					.pipe(Effect.mapError((error) => toProviderError(error)))
				if (customer.statusCode !== 200) {
					return yield* new OrganizationProviderError({
						message: `Billing returned HTTP ${customer.statusCode}; cannot confirm the organization is new`,
					})
				}
				if (responseHasPlanHistory(customer.response)) {
					return yield* new OrganizationRegionLockedError({
						message: "An organization that has held a plan keeps its data region.",
					})
				}
				// Clerk merges public metadata by key, so rollout flags stay as they are.
				const written = yield* clerk.value
					.run(
						Clerk.mergeOrganizationMetadata({
							organization_id: orgId,
							public_metadata: organizationRegionMetadata(region),
						}),
					)
					.pipe(Effect.mapError(toProviderError))
				// A yes this instance cached before the write may now be wrong.
				yield* regions.forget(orgId)
				// Clerk has no conditional write, so two admins choosing at once both succeed and the
				// later write wins. Answering with a fresh read rather than the request sends both to
				// the region that stuck in all but a same-instant race. The write already landed, so a
				// failed read falls back to what the write returned rather than failing the request.
				const stored = yield* getOrganization(clerk.value, orgId).pipe(
					Effect.catch((error) =>
						Effect.logWarning("Region read-back failed; answering with the write's result").pipe(
							Effect.annotateLogs({ orgId, error: error.message }),
							Effect.as(written),
						),
					),
				)
				return new ChooseOrganizationRegionResponse({
					region: organizationHomeRegion(stored.public_metadata),
				})
			})

			return {
				create,
				chooseRegion,
				retrieve,
			} satisfies OrganizationServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(AutumnClient.layer, OrganizationRegionService.layer)),
	)
}
