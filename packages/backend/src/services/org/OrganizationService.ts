import { createClerkClient } from "@clerk/backend"
import {
	ChooseOrganizationRegionResponse,
	CreateOrganizationResponse,
	DeleteOrganizationResponse,
	OrganizationForbiddenError,
	OrganizationPersistenceError,
	OrganizationProviderError,
	OrganizationRegionLockedError,
	OrgId,
	RoleName,
	type UserId,
} from "@maple/domain/http"
import {
	type MapleRegion,
	organizationHomeRegion,
	organizationRegionChosen,
	organizationRegionMetadata,
	organizationRegionOpen,
} from "@maple/domain/organization-regions"
import {
	actors,
	alertDeliveryEvents,
	alertDestinations,
	alertIncidents,
	alertRuleStates,
	alertRules,
	apiKeys,
	chatIdentities,
	chatWorkspaces,
	cliDeviceAuthorizations,
	cloudflareLogpushConnectors,
	dashboards,
	dashboardShares,
	dashboardVersions,
	digestSubscriptions,
	errorIncidents,
	errorIssueEvents,
	errorIssueStates,
	errorIssues,
	errorNotificationPolicies,
	liveActivities,
	mcpOAuthAuthorizations,
	mcpOAuthRefreshTokens,
	mobileDevices,
	oauthAuthStates,
	oauthConnections,
	orgClickHouseSettings,
	orgIngestKeys,
	planetscaleConnections,
	planetscaleIssueReceipts,
	scrapeTargets,
	slackWorkspaces,
	vcsCommits,
	prReviews,
	prReviewFindings,
	vcsInstallations,
	vcsRepositories,
} from "@maple/db"
import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { clerkRequest } from "@maple/backend/services/auth/clerk-request"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { responseHasPlanHistory } from "@maple/backend/services/billing/autumn-client"

const ROOT_ROLE = Schema.decodeSync(RoleName)("root")
const ORG_ADMIN_ROLE = Schema.decodeSync(RoleName)("org:admin")

const isOrgAdmin = (roles: ReadonlyArray<RoleName>) =>
	roles.includes(ROOT_ROLE) || roles.includes(ORG_ADMIN_ROLE)

const toPersistenceError = (error: unknown) =>
	new OrganizationPersistenceError({
		message: error instanceof Error ? error.message : "Organization persistence failed",
	})

const toProviderError = (error: unknown) =>
	new OrganizationProviderError({
		message: error instanceof Error ? error.message : "Organization provider call failed",
	})

const ORG_SCOPED_TABLES = [
	dashboardVersions,
	dashboards,
	alertDeliveryEvents,
	alertIncidents,
	alertRuleStates,
	alertRules,
	alertDestinations,
	apiKeys,
	orgIngestKeys,
	orgClickHouseSettings,
	scrapeTargets,
	oauthConnections,
	oauthAuthStates,
	// The binding that makes a chat workspace's members act as the org. Deleting
	// the org must stop the bot answering there, and nothing else would.
	chatWorkspaces,
	// Each row lets one chat account approve changes as one Maple user. Deleting the org must
	// end that standing authority, not leave it pointed at an org that is gone.
	chatIdentities,
	// Holds an encrypted Slack bot token and the id of a full-access API key —
	// there is no `orgs` table to cascade from, so this purge is what stops a
	// deleted org's live credentials outliving it.
	slackWorkspaces,
	digestSubscriptions,
	cloudflareLogpushConnectors,
	errorIssueEvents,
	errorIssueStates,
	errorIncidents,
	errorIssues,
	errorNotificationPolicies,
	actors,
	vcsInstallations,
	vcsRepositories,
	vcsCommits,
	prReviews,
	prReviewFindings,
	// Credentials that outlive the org unless they are purged here. `api_keys`
	// alone was not enough: an MCP grant's refresh family re-mints its key
	// hourly, so a deleted org's MCP client kept working for up to 30 days.
	mcpOAuthRefreshTokens,
	mobileDevices,
	// A share link is a public bearer credential: `resolveByToken` matches the
	// token hash and `revoked_at is null` and nothing else, then queries the
	// warehouse as the org. It only went dead on deletion by accident of a
	// downstream `dashboards` lookup, which is not a guarantee.
	dashboardShares,
	// Holds the encrypted per-connection webhook HMAC secret — standing
	// authority to have inbound writes attributed to an org that is gone.
	planetscaleConnections,
	// Dedupe receipts for the org's error issues, which are purged above; with the
	// connection gone no redelivery can arrive for them to catch.
	planetscaleIssueReceipts,
	// APNs update tokens for running Live Activities. `mobile_devices` is purged
	// here already; leaving these behind keeps a live push channel open.
	liveActivities,
] as const

/**
 * Same purge, different column: these two record an *approval* rather than
 * ownership, so the org they belong to is `approved_org_id`.
 */
const APPROVED_ORG_SCOPED_TABLES = [mcpOAuthAuthorizations, cliDeviceAuthorizations] as const

/**
 * Org-scoped tables deliberately left behind by `delete`. Every table with an
 * `org_id` must appear in exactly one of these three lists — the registry test
 * in `OrganizationService.org-scoped-tables.test.ts` fails on a new one that
 * appears in none, so "we forgot to register it" cannot happen silently again.
 *
 * Every name below has been read against its schema: none holds a token, hash,
 * ciphertext or other secret, and none is resolved by anything to grant access.
 * They are analytics, settings and history — retained data, which is a
 * retention question and a defensible follow-up, not a live-credential gap.
 * The three that failed that read (`dashboardShares`, `planetscaleConnections`,
 * `liveActivities`) were moved into the purge above rather than excused here.
 */
export const UNPURGED_ORG_SCOPED_TABLES = [
	"aiTriageSettings",
	"alertRuleClaims",
	"anomalyDetectorSettings",
	"anomalyDetectorStates",
	"anomalyIncidents",
	"cloudflareAnalyticsState",
	"cloudflareHyperdriveConfigs",
	"errorFingerprintCandidates",
	"errorIssuePullRequests",
	"errorIssueVerifications",
	"errorNotificationDeliveries",
	"errorTickStates",
	"investigations",
	"issueEscalationPolicies",
	"issueEscalations",
	"orgClickHouseSchemaApplyRuns",
	"orgIngestAttributeMappings",
	"orgIngestSamplingPolicies",
	"orgOnboardingState",
	"orgRecommendationIssues",
	"planetscaleDatabases",
	"planetscaleEvents",
	"planetscalePollState",
	"scrapeTargetChecks",
	"vcsRepositoryBranches",
] as const

export const ORG_DELETE_REGISTRY = {
	orgScoped: ORG_SCOPED_TABLES,
	approvedOrgScoped: APPROVED_ORG_SCOPED_TABLES,
	unpurged: UNPURGED_ORG_SCOPED_TABLES,
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
		roles: ReadonlyArray<RoleName>,
		region: MapleRegion,
	) => Effect.Effect<
		ChooseOrganizationRegionResponse,
		OrganizationForbiddenError | OrganizationRegionLockedError | OrganizationProviderError
	>
	readonly retrieve: (orgId: OrgId) => Effect.Effect<OrganizationInfo, OrganizationProviderError>
	readonly delete: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		DeleteOrganizationResponse,
		OrganizationForbiddenError | OrganizationPersistenceError | OrganizationProviderError
	>
}

export class OrganizationService extends Context.Service<OrganizationService, OrganizationServiceApi>()(
	"@maple/api/services/OrganizationService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env

			const autumn = yield* AutumnClient

			const requireAdmin = Effect.fn("OrganizationService.requireAdmin")(function* (
				roles: ReadonlyArray<RoleName>,
				action: string,
			) {
				if (isOrgAdmin(roles)) return
				return yield* Effect.fail(
					new OrganizationForbiddenError({
						message: `Only org admins can ${action}`,
					}),
				)
			})

			const purgeOrgScopedRows = Effect.fn("OrganizationService.purgeOrgScopedRows")(function* (
				orgId: OrgId,
			) {
				yield* Effect.forEach(
					ORG_SCOPED_TABLES,
					(table) =>
						database
							.execute((db) => db.delete(table).where(eq(table.orgId, orgId)))
							.pipe(Effect.mapError(toPersistenceError)),
					{ discard: true },
				)
				yield* Effect.forEach(
					APPROVED_ORG_SCOPED_TABLES,
					(table) =>
						database
							.execute((db) => db.delete(table).where(eq(table.approvedOrgId, orgId)))
							.pipe(Effect.mapError(toPersistenceError)),
					{ discard: true },
				)
			})

			/** The Clerk backend client, or `None` when not running in Clerk auth mode. */
			const clerkClient = () =>
				env.MAPLE_AUTH_MODE.toLowerCase() === "clerk" && Option.isSome(env.CLERK_SECRET_KEY)
					? Option.some(
							createClerkClient({ secretKey: Redacted.value(env.CLERK_SECRET_KEY.value) }),
						)
					: Option.none()

			const deleteClerkOrganization = Effect.fn("OrganizationService.deleteClerkOrganization")(
				function* (orgId: OrgId) {
					yield* Effect.annotateCurrentSpan("orgId", orgId)
					const clerk = clerkClient()
					if (Option.isNone(clerk)) return

					yield* clerkRequest("Clerk.organizations.deleteOrganization", { orgId }, () =>
						clerk.value.organizations.deleteOrganization(orgId),
					).pipe(Effect.mapError((error) => toProviderError(error.cause)))
				},
			)

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
				const org = yield* clerkRequest("Clerk.organizations.getOrganization", { orgId }, () =>
					clerk.value.organizations.getOrganization({ organizationId: orgId }),
				).pipe(Effect.mapError((error) => toProviderError(error.cause)))
				return {
					id: orgId,
					name: org.name,
					slug: org.slug,
					imageUrl: org.hasImage ? org.imageUrl : null,
					createdAtMs: org.createdAt,
				} satisfies OrganizationInfo
			})

			const create = Effect.fn("OrganizationService.create")(function* (
				userId: UserId,
				name: string,
				region: MapleRegion,
			) {
				yield* Effect.annotateCurrentSpan({ userId, "maple.org_region": region })
				const clerk = clerkClient()
				if (Option.isNone(clerk)) {
					return yield* new OrganizationProviderError({
						message: "Organizations can only be created in Clerk auth mode",
					})
				}
				const org = yield* clerkRequest("Clerk.organizations.createOrganization", { userId }, () =>
					clerk.value.organizations.createOrganization({
						name,
						createdBy: userId,
						publicMetadata: organizationRegionMetadata(region),
					}),
				).pipe(Effect.mapError((error) => toProviderError(error.cause)))
				const orgId = yield* Schema.decodeUnknownEffect(OrgId)(org.id).pipe(
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
				roles: ReadonlyArray<RoleName>,
				region: MapleRegion,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.org_region": region })
				yield* requireAdmin(roles, "choose the data region")
				const clerk = clerkClient()
				if (Option.isNone(clerk)) {
					return yield* new OrganizationProviderError({
						message: "Data regions can only be chosen in Clerk auth mode",
					})
				}
				const org = yield* clerkRequest("Clerk.organizations.getOrganization", { orgId }, () =>
					clerk.value.organizations.getOrganization({ organizationId: orgId }),
				).pipe(Effect.mapError((error) => toProviderError(error.cause)))
				if (organizationRegionChosen(org.publicMetadata)) {
					// Choosing the region it already has is a no-op, so a retried request succeeds.
					if (organizationHomeRegion(org.publicMetadata) === region) {
						return new ChooseOrganizationRegionResponse({ region })
					}
					return yield* new OrganizationRegionLockedError({
						message: "This organization's data region has already been chosen.",
					})
				}
				// An organization that predates regions has data on US already, plan or not.
				if (
					!organizationRegionOpen(org.publicMetadata, org.createdAt, yield* Clock.currentTimeMillis)
				) {
					return yield* new OrganizationRegionLockedError({
						message: "Only a new organization can choose its data region.",
					})
				}
				const customer = yield* autumn
					.getOrCreateCustomer(orgId, { expand: [] })
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
				const written = yield* clerkRequest(
					"Clerk.organizations.updateOrganizationMetadata",
					{ orgId },
					() =>
						clerk.value.organizations.updateOrganizationMetadata(orgId, {
							publicMetadata: organizationRegionMetadata(region),
						}),
				).pipe(Effect.mapError((error) => toProviderError(error.cause)))
				// Clerk has no conditional write, so two admins choosing at once both succeed and the
				// later write wins. Answering with a fresh read rather than the request sends both to
				// the region that stuck in all but a same-instant race. The write already landed, so a
				// failed read falls back to what the write returned rather than failing the request.
				const stored = yield* clerkRequest("Clerk.organizations.getOrganization", { orgId }, () =>
					clerk.value.organizations.getOrganization({ organizationId: orgId }),
				).pipe(
					Effect.catch((error) =>
						Effect.logWarning("Region read-back failed; answering with the write's result").pipe(
							Effect.annotateLogs({ orgId, error: error.message }),
							Effect.as(written),
						),
					),
				)
				return new ChooseOrganizationRegionResponse({
					region: organizationHomeRegion(stored.publicMetadata),
				})
			})

			const deleteOrganization = Effect.fn("OrganizationService.delete")(function* (
				orgId: OrgId,
				roles: ReadonlyArray<RoleName>,
			) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				yield* requireAdmin(roles, "delete the organization")
				yield* purgeOrgScopedRows(orgId)
				yield* deleteClerkOrganization(orgId)
				return new DeleteOrganizationResponse({ deleted: true })
			})

			return {
				create,
				chooseRegion,
				retrieve,
				delete: deleteOrganization,
			} satisfies OrganizationServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(AutumnClient.layer))

	static readonly retrieve = (orgId: OrgId) => this.use((service) => service.retrieve(orgId))

	static readonly delete = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.delete(orgId, roles))
}
