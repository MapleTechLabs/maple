/**
 * The cancellation review: one cancelled subscription in, one report out, to
 * Slack, Hazel or both.
 *
 * Gathers what the org's own usage looks like around the cancellation, reads it
 * with fixed rules, and posts the result to Maple's own workspaces. Every source
 * but Autumn is optional: a section that cannot be read is `null` in the
 * snapshot and named in the report, because a report missing its visit numbers
 * is worth more than no report.
 *
 * It runs on the `cancellation-reviews` queue, off the Autumn webhook's request.
 * A `CancellationReviewError` is retried there with backoff; the claim row keeps
 * a retry, or a second delivery of the webhook, from posting twice.
 */
import { ownBillingCustomer } from "@maple/backend/services/billing/billing-customer"
import * as PG from "@maple-dev/effect-orm/postgres"
import { type ChatBlock, chatConnectorId, type ChatOutboundError, splitBlocks } from "@maple/chat-platform"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import {
	AlertRules,
	CancellationReviews,
	ChatWorkspaces,
	Dashboards,
	OAuthConnections,
	OrgSupportChannels,
	VcsInstallations,
} from "@maple/db/tables"
import { isActivePlanSubscription, isPlanSubscription } from "@maple/domain/billing"
import {
	BillingCustomerId,
	CancellationAppEvidence,
	CancellationBillingEvidence,
	CancellationCompanyEvidence,
	CancellationModelRequest,
	CancellationSnapshot,
	CancellationTelemetryEvidence,
	OrgId,
} from "@maple/domain/http"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import {
	Cause,
	Clock,
	Context,
	DateTime,
	Duration,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
	String as Str,
	Array as Arr,
	Record as Rec,
} from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { FetchHttpClient, HttpClient } from "effect/http"
import { parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { systemTenant } from "@maple/backend/services/alerts/system-tenant"
import { AUDIT_ACCESS_ACTION_SUFFIXES, AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { decodeUpstream, ensureOk, subscriptionsOf } from "@maple/backend/services/billing/autumn-client"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { stripeCustomerIdOf } from "@maple/backend/services/billing/billing-profile"
import { StripeClient } from "@maple/backend/services/billing/stripe-http"
import {
	ChatConnectorRegistry,
	chatOutboundTransport,
	loadOwnedChatWorkspace,
	missingOutboundConfig,
	type OwnedChatWorkspace,
} from "@maple/backend/services/integrations/chat-outbound"
import { IntegrationInventoryService } from "@maple/backend/services/integrations/IntegrationInventoryService"
import { DailySpendService } from "@maple/backend/services/billing/DailySpendService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import type { PlanCancellation } from "@maple/backend/services/product-events/autumn-events"
import { SupportSlackClient } from "@maple/backend/services/support/SupportSlackClient"
import type { SupportChannelUnavailableError } from "@maple/domain/support-channel"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { CancellationReader } from "./CancellationReader"
import { buildCancellationChatBlocks } from "./chat-message"
import {
	AUDIT_ENTRIES_SHOWN,
	SESSIONS_READ,
	SESSIONS_SHOWN,
	TRANSCRIPT_PAGES,
	TRANSCRIPT_PROBLEMS,
	auditEntryOf,
	digestSession,
	otherOrgsOf,
	stripeFeedbackOf,
} from "./evidence"
import { CancellationAppEvidenceReader } from "./evidence-app"
import { CancellationBillingEvidenceReader } from "./evidence-billing"
import { CancellationCompanyEvidenceReader, isMapleStaff } from "./evidence-company"
import { type CancellationEvidenceInput, EVIDENCE_GRACE_MS, knownAtCancel } from "./evidence-input"
import { CancellationTelemetryEvidenceReader } from "./evidence-telemetry"
import { deriveSignals, ruleReason } from "./signals"
import { type CancellationReport, OTHER_ORGS_SHOWN, type OrgLinks, type OtherOrg } from "./report"
import { buildCancellationMessage } from "./slack-message"
import {
	DAY_MS,
	WINDOW_DAYS,
	ingestWindow,
	summarizeBilling,
	summarizeIngest,
	summarizeVisits,
	visitsWindow,
} from "./snapshot"

/** A cancellation as the webhook read it, for an org id this instance could have issued. */
export interface CancellationToReview extends Omit<PlanCancellation, "orgId"> {
	readonly orgId: OrgId
	/** Epoch ms the delivery arrived; stands in for a cancellation time Autumn did not send. */
	readonly receivedAt: number
}

/**
 * How long an unposted review belongs to the delivery that claimed it: past the
 * longest a review can run (evidence, then the model), so a second delivery
 * waits rather than posting beside it.
 */
const CLAIM_LEASE_MS = 5 * 60 * 1000

/**
 * How long any one source may take; a slow one is left out of the report. Every
 * read has one, so a review always ends well inside its claim's lease.
 */
const SOURCE_TIMEOUT = "30 seconds"

/** One destination's post, after which the report is out there. */
const POST_TIMEOUT = "30 seconds"

/** The org reads every other read waits on get less. */
const ORG_TIMEOUT = "10 seconds"

/** Members whose other orgs are looked up: one Clerk call each. */
const OTHER_ORGS_MEMBER_LIMIT = 10

/** A failure worth another delivery: Clerk, Autumn, Postgres, Slack or Hazel did not answer. */
export class CancellationReviewError extends Schema.TaggedError<CancellationReviewError>()(
	"@maple/backend/cancellation-review/CancellationReviewError",
	{
		message: Schema.String,
		step: Schema.Literals(["region", "billing", "claim", "post"]),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export type CancellationReviewOutcome =
	| "posted"
	/** This subscription's cancellation was already reported. */
	| "duplicate"
	/**
	 * Every destination refused the post for a reason no retry fixes (bot not in the channel, bad
	 * channel id).
	 */
	| "refused"
	/** The org lives on another region's instance, which reports it. */
	| "other_region"
	/** Clerk no longer has the org, so no region can report it and a retry never will. */
	| "org_deleted"
	/** An add-on going away is not the org leaving. */
	| "not_a_plan"
	/** The plan ended but the org still holds an active one: a switch or a resubscription. */
	| "still_subscribed"
	/** Neither a Slack channel and bot token nor a Hazel channel Maple's org can post to. */
	| "not_configured"

export interface CancellationReviewServiceApi {
	readonly review: (
		cancellation: CancellationToReview,
	) => Effect.Effect<CancellationReviewOutcome, CancellationReviewError>
}

/**
 * Only what the billing section reads off Autumn's customer, so a field it does
 * not use changing type cannot cost the report its invoices. Autumn omits
 * `invoices` for a customer that has none.
 */
const CustomerBilling = Schema.Struct({
	balances: Schema.optionalKey(
		Schema.NullOr(
			Schema.Record(
				Schema.String,
				Schema.Struct({
					granted: Schema.optionalKey(Schema.NullOr(Schema.Number)),
					usage: Schema.optionalKey(Schema.NullOr(Schema.Number)),
					unlimited: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
				}),
			),
		),
	),
	invoices: Schema.optionalKey(
		Schema.NullOr(
			Schema.Array(
				Schema.Struct({ status: Schema.String, total: Schema.Number, createdAt: Schema.Number }),
			),
		),
	),
})

/** Maple's own org links its Hazel workspace through this connector. */
const HAZEL_CONNECTOR_ID = chatConnectorId("hazel")

/** The channel in Maple's own Hazel workspace that reports go to. */
interface HazelDestination {
	readonly workspace: OwnedChatWorkspace
	readonly channelId: string
}

/** Somewhere the report goes; `post` is true once it is out, false when refused for good. */
interface Destination {
	readonly name: "Slack" | "Hazel"
	readonly postedAttribute: "maple.cancellation.slack_posted" | "maple.cancellation.hazel_posted"
	readonly post: (
		report: CancellationReport,
	) => Effect.Effect<boolean, Schema.SchemaError | SupportChannelUnavailableError | ChatOutboundError>
}

/** The upstream's own words, so the log says why and not only where. */
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const failedAt =
	(step: CancellationReviewError["step"], message: string) =>
	(cause: unknown): CancellationReviewError =>
		new CancellationReviewError({
			message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
			step,
			cause,
		})

export class CancellationReviewService extends Context.Service<
	CancellationReviewService,
	CancellationReviewServiceApi
>()("@maple/backend/cancellation-review/CancellationReviewService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const database = yield* Database
		const regions = yield* OrganizationRegionService
		const organizations = yield* OrganizationService
		const members = yield* OrgMembersService
		const onboarding = yield* OnboardingService
		const dailySpend = yield* DailySpendService
		const warehouse = yield* WarehouseQueryService
		const random = yield* SecureRandom.SecureRandom
		const ingestKeys = yield* OrgIngestKeysService
		const autumn = yield* AutumnClient
		const slack = yield* SupportSlackClient
		const inventory = yield* IntegrationInventoryService
		const auditLog = yield* AuditLogService
		const stripe = yield* StripeClient
		const reader = yield* CancellationReader
		const companyEvidence = yield* CancellationCompanyEvidenceReader
		const billingEvidence = yield* CancellationBillingEvidenceReader
		const appEvidence = yield* CancellationAppEvidenceReader
		const telemetryEvidence = yield* CancellationTelemetryEvidenceReader
		const httpClient = yield* HttpClient.HttpClient
		const chatConnectors = yield* ChatConnectorRegistry
		// An Option rather than failing the layer: a bad key costs only the Hazel report, and the
		// services that seal chat credentials refuse to boot on one first.
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => message,
		).pipe(Effect.option)

		const clerkOrgUrl = (orgId: string) =>
			Option.match(env.MAPLE_CLERK_DASHBOARD_URL, {
				onSome: (base) => `${Str.replace(/\/+$/, "")(base)}/organizations/${orgId}`,
				onNone: () => `https://dashboard.clerk.com/last-active?path=organizations/${orgId}`,
			})

		/** `customer` is Autumn's raw customer, null when it could not be read. */
		const orgLinks = (orgId: string, customer: unknown): OrgLinks => ({
			clerk: clerkOrgUrl(orgId),
			autumn: `https://app.useautumn.com/customers/${encodeURIComponent(orgId)}`,
			stripe: Option.match(stripeCustomerIdOf(customer), {
				onNone: () => null,
				onSome: (customerId) => `https://dashboard.stripe.com/customers/${customerId}`,
			}),
		})

		/** A source that could not be read in time is `null` in the report, never the end of it. */
		const optional = <A, E>(
			name: string,
			read: Effect.Effect<A, E>,
			timeout: Duration.Input = SOURCE_TIMEOUT,
		): Effect.Effect<A | null> =>
			read.pipe(
				Effect.timeout(timeout),
				Effect.map((value): A | null => value),
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning("cancellation review could not read a source").pipe(
								Effect.annotateLogs({ source: name, error: summarizeCause(cause) }),
								Effect.as(null),
							),
				),
				Effect.withSpan("CancellationReviewService.readSource", {
					attributes: { "maple.cancellation.source": name },
				}),
			)

		const count = (
			query: (orm: MapleDb) => Effect.Effect<ReadonlyArray<{ readonly count: number }>, MapleDbError>,
		) => database.execute((db) => query(db)).pipe(Effect.map((rows) => rows[0]?.count ?? 0))

		const readOrg = (orgId: OrgId) =>
			Effect.all(
				{
					info: organizations.retrieve(orgId),
					// Clerk-less deployments have no member directory; the count is then unknown.
					members: members.listMembers(orgId).pipe(
						Effect.map(
							(
								list,
							): ReadonlyArray<{ userId: string; email: string; name: string | null }> | null =>
								list,
						),
						Effect.orElseSucceed(() => null),
					),
					state: onboarding.findState(orgId).pipe(Effect.map(Option.getOrNull)),
					supportChannels: count((orm) =>
						orm.run(
							PG.from(OrgSupportChannels)
								.select(() => ({ count: PG.count() }))
								.where(($) => [$.orgId.eq(orgId), $.slackChannelId.isNotNull()]),
						),
					),
				},
				{ concurrency: 4 },
			)

		const readAdoption = (orgId: OrgId) =>
			Effect.all(
				{
					dashboards: count((orm) =>
						orm.run(
							PG.from(Dashboards)
								.select(() => ({ count: PG.count() }))
								.where(($) => [$.orgId.eq(orgId)]),
						),
					),
					alertRules: count((orm) =>
						orm.run(
							PG.from(AlertRules)
								.select(() => ({ count: PG.count() }))
								.where(($) => [$.orgId.eq(orgId)]),
						),
					),
					oauth: count((orm) =>
						orm.run(
							PG.from(OAuthConnections)
								.select(() => ({ count: PG.count() }))
								.where(($) => [$.orgId.eq(orgId), $.revokedAt.isNull()]),
						),
					),
					vcs: count((orm) =>
						orm.run(
							PG.from(VcsInstallations)
								.select(() => ({ count: PG.count() }))
								.where(($) => [$.orgId.eq(orgId), $.status.eq("active")]),
						),
					),
					chat: count((orm) =>
						orm.run(
							PG.from(ChatWorkspaces)
								.select(() => ({ count: PG.count() }))
								.where(($) => [$.orgId.eq(orgId)]),
						),
					),
				},
				// One socket per event: these run one after another on it either way.
				{ concurrency: 1 },
			).pipe(
				Effect.map(({ oauth, vcs, chat, ...counts }) => ({
					...counts,
					integrations: oauth + vcs + chat,
				})),
			)

		const readIngest = (orgId: OrgId, atMs: number) => {
			const window = ingestWindow(atMs)
			return dailySpend
				.get(systemTenant(orgId), { ...window, nowMs: atMs })
				.pipe(Effect.map((response) => summarizeIngest(response.days, atMs)))
		}

		/**
		 * The org Maple reports its own app usage under: whichever one owns the
		 * product-events key. The customer's page views and browser sessions live
		 * there, tagged with the customer's org as `GroupId`.
		 */
		const readOwnOrg = Effect.gen(function* () {
			const key = Option.orElse(env.MAPLE_PRODUCT_EVENTS_INGEST_KEY, () => env.MAPLE_INGEST_KEY)
			if (Option.isNone(key)) return null
			const own = yield* ingestKeys.resolveIngestKey(Redacted.value(key.value))
			return Option.isNone(own) ? null : own.value.orgId
		})

		/** The org's people in Maple's own app, from the page views under Maple's org. */
		const readVisits = Effect.fn("CancellationReviewService.readVisits")(function* (
			orgId: OrgId,
			atMs: number,
			ownOrgId: OrgId | null,
		) {
			if (ownOrgId === null) return null
			const window = visitsWindow(atMs)
			const pageViews = (groupIds: ReadonlyArray<string> | undefined, bucketSeconds: number) =>
				warehouse.compiledQuery(
					systemTenant(ownOrgId),
					CH.compile(
						CH.productEventsTimeseriesQuery({
							metric: "users",
							sources: ["browser"],
							bucketSeconds,
							...(groupIds === undefined ? undefined : { groupIds }),
						}),
						{
							orgId: ownOrgId,
							startTime: formatWarehouseDateTime(window.startMs),
							endTime: formatWarehouseDateTime(window.endMs),
							bucketSeconds,
						},
					),
					{ profile: "list", context: "cancellationReviewVisits" },
				)
			const rows = yield* pageViews([orgId], DAY_MS / 1000)
			if (rows.length === 0) {
				// No visits, or the wrong org: the key is configurable, and an org with no
				// page views from anyone is not the one the app reports to. Saying
				// "nobody opened the app" off that would be wrong for every review.
				const anyone = yield* pageViews(undefined, (WINDOW_DAYS * 2 * DAY_MS) / 1000)
				if (anyone.length === 0) {
					yield* Effect.logWarning(
						"cancellation review found no app page views under the product-events key's org",
					)
					return null
				}
			}
			return summarizeVisits(
				Arr.map(rows, (row) => ({ dayMs: DateTime.toEpochMillis(row.bucket), users: row.value })),
				atMs,
			)
		})

		/**
		 * The org's browser sessions in Maple's own app up to the cancellation,
		 * newest first, the latest few with their last pages and problems.
		 */
		const readSessions = Effect.fn("CancellationReviewService.readSessions")(function* (
			orgId: OrgId,
			atMs: number,
			ownOrgId: OrgId | null,
		) {
			if (ownOrgId === null) return null
			const tenant = systemTenant(ownOrgId)
			const rows = yield* warehouse.compiledQuery(
				tenant,
				// Read a few extra, to still show `SESSIONS_SHOWN` once bots are dropped.
				CH.compile(CH.sessionReplaysListQuery({ groupId: orgId, limit: SESSIONS_SHOWN * 2 }), {
					orgId: ownOrgId,
					startTime: formatWarehouseDateTime(atMs - WINDOW_DAYS * DAY_MS),
					// Up to the visit the org cancelled in; later visits are not why it left.
					endTime: formatWarehouseDateTime(atMs + EVIDENCE_GRACE_MS),
				}),
				{ profile: "list", context: "cancellationReviewSessions" },
			)
			const transcript = (row: (typeof rows)[number], options: CH.SessionTranscriptOpts) =>
				warehouse
					.compiledQuery(
						tenant,
						CH.compile(
							CH.sessionTranscriptQuery({
								...options,
								newestFirst: true,
								startTime: row.startTime,
								...(row.endTime === null ? undefined : { endTime: row.endTime }),
							}),
							{ orgId: ownOrgId, sessionId: row.sessionId },
						),
						{ profile: "list", context: "cancellationReviewSessionEvents" },
					)
					.pipe(Effect.map((events) => Arr.reverse(events)))
			return yield* Effect.forEach(
				Arr.filter(rows, (row) => row.quality !== "bot").slice(0, SESSIONS_SHOWN),
				(row, index) =>
					index < SESSIONS_READ
						? Effect.all([
								transcript(row, { types: ["navigation"], limit: TRANSCRIPT_PAGES }),
								transcript(row, { errorsOnly: true, limit: TRANSCRIPT_PROBLEMS }),
							]).pipe(
								Effect.map(([pages, problems]) => digestSession(atMs, row, pages, problems)),
							)
						: Effect.succeed(digestSession(atMs, row, [], [])),
				{ concurrency: 3 },
			)
		})

		/**
		 * The org's changes around the cancellation. Reads and tool calls are left
		 * out in the query, before the limit; the telemetry section counts them.
		 */
		const readAuditLog = (orgId: OrgId, atMs: number) =>
			auditLog
				.list(orgId, {
					sinceMs: atMs - WINDOW_DAYS * DAY_MS,
					untilMs: atMs + EVIDENCE_GRACE_MS,
					excludeActionSuffixes: AUDIT_ACCESS_ACTION_SUFFIXES,
					limit: AUDIT_ENTRIES_SHOWN,
					offset: 0,
				})
				.pipe(Effect.map((entries) => Arr.map(entries, (entry) => auditEntryOf(atMs, entry))))

		/** What the customer told Stripe when cancelling; nothing to tell without a Stripe customer. */
		const readStripeFeedback = (customer: unknown, atMs: number) =>
			Option.match(stripeCustomerIdOf(customer), {
				onNone: () => Effect.succeed({ feedback: null, comment: null }),
				onSome: (customerId) =>
					stripe.listSubscriptions(customerId).pipe(
						Effect.flatMap(ensureOk),
						Effect.flatMap((response) => stripeFeedbackOf(response, atMs)),
					),
			})

		/**
		 * An evidence section, checked against its schema: a reader that built a
		 * bad value (a negative count) loses its section, not the whole report.
		 */
		const section = <S extends Schema.Top & { readonly DecodingServices: never }>(
			name: string,
			schema: S,
			read: Effect.Effect<S["Type"]>,
		) => optional(name, read.pipe(Effect.flatMap((value) => Schema.decodeUnknownEffect(schema)(value))))

		/**
		 * Orgs the members also belong to: a customer moving to another org is not
		 * leaving. Maple staff are skipped: their other orgs are the customers they help.
		 */
		const readOtherOrgs = (orgId: OrgId, people: ReadonlyArray<{ userId: string; email: string }>) =>
			Effect.forEach(
				Arr.filter(people, (person) => !isMapleStaff(person.email)).slice(0, OTHER_ORGS_MEMBER_LIMIT),
				(person) =>
					members
						.listOrganizationsOf(person.userId)
						.pipe(Effect.map((orgs) => Arr.map(orgs, (org) => ({ org, email: person.email })))),
				{ concurrency: 4 },
			).pipe(
				Effect.map((perPerson) => {
					const byOrg = new Map<string, Omit<OtherOrg, "links" | "billing">>()
					for (const { org, email } of perPerson.flat()) {
						if (org.orgId === orgId) continue
						const seen = byOrg.get(org.orgId)
						byOrg.set(org.orgId, {
							orgId: org.orgId,
							name: org.name,
							createdAtMs: org.createdAtMs,
							membersCount: org.membersCount,
							sharedMembers: [...(seen?.sharedMembers ?? []), email],
						})
					}
					return [...byOrg.values()].sort((a, b) => b.createdAtMs - a.createdAtMs)
				}),
				// Only the orgs the report shows. Every Maple org already has an Autumn
				// customer from the app's own reads, and this never creates a Stripe one.
				Effect.flatMap((orgs) =>
					Effect.forEach(
						orgs,
						(org, index) =>
							(index < OTHER_ORGS_SHOWN
								? optional(
										"otherOrgBilling",
										autumn
											// Each org's own customer: the report is about the orgs themselves.
											.getOrCreateCustomer(BillingCustomerId.make(org.orgId), {
												expand: [],
											})
											.pipe(Effect.flatMap(ensureOk)),
									)
								: Effect.succeed(null)
							).pipe(
								Effect.map((customer): OtherOrg => ({
									...org,
									links: orgLinks(org.orgId, customer),
									billing:
										customer === null
											? null
											: {
													plan:
														Option.getOrUndefined(
															Arr.findFirst(
																subscriptionsOf(customer),
																isActivePlanSubscription,
															),
														)?.planId ?? null,
												},
								})),
							),
						{ concurrency: 3 },
					),
				),
			)

		/**
		 * The row that makes this subscription's review happen once. Autumn may
		 * send no start; the cancellation's own timestamp then names it, which a
		 * scheduled cancellation and its later expiry still share.
		 */
		const claim = (job: CancellationToReview, nowMs: number) =>
			database
				.execute((db) =>
					Effect.gen(function* () {
						const subscriptionStartedAt = job.startedAt ?? job.canceledAt ?? 0
						const id = yield* random.uuidV4()
						const inserted = yield* db.run(
							PG.insertInto(CancellationReviews)
								.values({
									id,
									orgId: job.orgId,
									planId: job.planId,
									subscriptionStartedAt,
									canceledAt: job.canceledAt,
									createdAt: nowMs,
									updatedAt: nowMs,
								})
								.onConflictDoNothing()
								.returning("id"),
						)
						if (inserted[0] !== undefined)
							return { id: inserted[0].id, state: "claimed" as const }
						const [existing] = yield* db.run(
							PG.from(CancellationReviews)
								.select("id", "postedAt", "canceledAt", "updatedAt")
								.where(($) => [
									$.orgId.eq(job.orgId),
									$.planId.eq(job.planId),
									$.subscriptionStartedAt.eq(subscriptionStartedAt),
								])
								.limit(1),
						)
						if (existing === undefined) return { id: "", state: "busy" as const }
						// Cancelled, kept after all, then cancelled again: a new decision on
						// the same subscription, and the one that counts.
						const cancelledAgain =
							job.phase === "scheduled" &&
							job.canceledAt !== null &&
							existing.canceledAt !== null &&
							job.canceledAt > existing.canceledAt
						if (existing.postedAt !== null && !cancelledAgain) {
							return { id: existing.id, state: "posted" as const }
						}
						// Unposted and recently touched: another delivery is on it.
						if (existing.postedAt === null && nowMs - existing.updatedAt < CLAIM_LEASE_MS) {
							return { id: existing.id, state: "busy" as const }
						}
						// Take it over, unless another delivery took it between the read and here.
						const taken = yield* db.run(
							PG.update(CancellationReviews)
								.set({ postedAt: null, updatedAt: nowMs })
								.where(($) => [$.id.eq(existing.id), $.updatedAt.eq(existing.updatedAt)])
								.returning("id"),
						)
						return {
							id: existing.id,
							state: taken.length === 0 ? ("busy" as const) : ("claimed" as const),
						}
					}),
				)
				.pipe(Effect.mapError(failedAt("claim", "Could not claim the cancellation review")))

		/**
		 * Hands an unposted review back, so the next attempt takes it over at once;
		 * only while this delivery still holds it (`claimedAt`), never one another
		 * delivery took over after its lease.
		 */
		const releaseClaim = (id: string, claimedAt: number) =>
			database
				.execute((db) =>
					db.run(
						PG.update(CancellationReviews)
							.set({ updatedAt: 0 })
							.where(($) => [$.id.eq(id), $.postedAt.isNull(), $.updatedAt.eq(claimedAt)]),
					),
				)
				.pipe(Effect.ignore)

		/**
		 * Maple's own Hazel workspace and the channel reports go to, when the deployment names a
		 * channel, Maple's org has linked a Hazel workspace and this deployment can post through it.
		 * Anything short of that leaves Hazel out with a warning; only an unanswered lookup retries.
		 */
		const findHazel = Effect.gen(function* () {
			const channelId = env.MAPLE_CANCELLATION_HAZEL_CHANNEL_ID
			if (Option.isNone(channelId)) return null
			const ownOrgId = Option.flatMap(env.MAPLE_INTERNAL_ORG_ID, Schema.decodeUnknownOption(OrgId))
			if (Option.isNone(ownOrgId) || Option.isNone(encryptionKey)) {
				yield* Effect.logWarning(
					"cancellation reviews have a Hazel channel but no MAPLE_INTERNAL_ORG_ID or usable encryption key; nothing is posted to Hazel",
				)
				return null
			}
			const [linked] = yield* database.execute((db) =>
				db.run(
					PG.from(ChatWorkspaces)
						.select("id")
						.where(($) => [$.orgId.eq(ownOrgId.value), $.connector.eq(HAZEL_CONNECTOR_ID)])
						.orderBy(($) => [[$.createdAt, "asc"]])
						.limit(1),
				),
			)
			const workspace =
				linked === undefined
					? Option.none<OwnedChatWorkspace>()
					: yield* loadOwnedChatWorkspace(
							database,
							chatConnectors,
							ownOrgId.value,
							linked.id,
							encryptionKey.value,
						)
			if (Option.isNone(workspace)) {
				yield* Effect.logWarning(
					"cancellation reviews have a Hazel channel but Maple's org has no Hazel workspace linked; nothing is posted to Hazel",
				)
				return null
			}
			const missing = missingOutboundConfig(workspace.value, env.CHAT_CONNECTOR_OUTBOUND_CONFIG)
			if (missing.length > 0) {
				yield* Effect.logWarning(
					"cancellation reviews have a Hazel channel but this deployment cannot post to Hazel; nothing is posted to Hazel",
				).pipe(Effect.annotateLogs({ missingConfig: Arr.join(missing, ", ") }))
				return null
			}
			return { workspace: workspace.value, channelId: channelId.value } satisfies HazelDestination
		}).pipe(
			// Only a reinstall writes a new credential: no retry gets past it.
			Effect.catchTag("@maple/backend/ChatWorkspaceCredentialsUnreadable", (error) =>
				Effect.logError(
					"Maple's Hazel workspace credential is unreadable; nothing is posted to Hazel",
				).pipe(Effect.annotateLogs({ error: error.message }), Effect.as(null)),
			),
			Effect.mapError(failedAt("post", "Could not look up Maple's Hazel workspace")),
		)

		const postToSlack = (channel: string) => (report: CancellationReport) =>
			Effect.gen(function* () {
				const message = buildCancellationMessage(report)
				const blocks = yield* encodeJson(message.blocks)
				return yield* slack
					.call("chat.postMessage", { channel, text: message.text, blocks, unfurl_links: false })
					.pipe(
						Effect.as(true),
						// Slack answered and said no: redelivering changes nothing, and failing
						// here would hold this delivery's plan events back for hours. The row
						// stays unposted, so a scheduled cancellation is tried again at expiry.
						Effect.catchTag("@maple/backend/support/SupportSlackRefusedError", (error) =>
							Effect.logError("Slack refused the cancellation report; it was not posted").pipe(
								Effect.annotateLogs({
									slackError: error.error,
									slackDetails: Arr.join(error.details ?? [], "\n"),
								}),
								Effect.as(false),
							),
						),
					)
			})

		/** One message, or one per section when the report is longer than Hazel takes in one. */
		const postToHazel = (hazel: HazelDestination) => (report: CancellationReport) =>
			Effect.gen(function* () {
				const { workspace, channelId } = hazel
				const transport = yield* chatOutboundTransport(
					workspace,
					env.CHAT_CONNECTOR_OUTBOUND_CONFIG,
					httpClient,
				)
				const target = { workspaceId: workspace.externalWorkspaceId, channelId }
				const messages: ReadonlyArray<ReadonlyArray<ChatBlock>> = splitBlocks(
					buildCancellationChatBlocks(report),
					workspace.connector.outbound.limits.maxMessageChars,
				)
				yield* Effect.forEach(messages, (blocks) => transport.post(target, blocks), { discard: true })
				return true
			}).pipe(
				// The bot's grant, the channel or the message itself: a retry changes none of them.
				Effect.catchIf(
					(error) =>
						error.reason === "auth" ||
						error.reason === "not_found" ||
						error.reason === "rejected",
					(error) =>
						Effect.logError("Hazel refused the cancellation report; it was not posted").pipe(
							Effect.annotateLogs({ hazelError: error.message, reason: error.reason ?? "" }),
							Effect.as(false),
						),
				),
			)

		const review: CancellationReviewServiceApi["review"] = Effect.fn("CancellationReviewService.review")(
			function* (job) {
				const { orgId } = job
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.cancellation.plan_id": job.planId,
					"maple.cancellation.phase": job.phase,
				})
				const outcome = (value: CancellationReviewOutcome) =>
					Effect.annotateCurrentSpan({ "maple.cancellation.outcome": value }).pipe(Effect.as(value))

				const slackChannel = env.MAPLE_CANCELLATION_SLACK_CHANNEL_ID
				if (Option.isSome(slackChannel) && !slack.configured) {
					yield* Effect.logWarning(
						"cancellation reviews have a Slack channel but no Slack bot token; nothing is posted to Slack",
					)
				}
				const hazel = yield* findHazel
				// Slack first: with both set, it is the one whose failure retries the review.
				const destinations: ReadonlyArray<Destination> = [
					...(Option.isSome(slackChannel) && slack.configured
						? [
								{
									name: "Slack" as const,
									postedAttribute: "maple.cancellation.slack_posted" as const,
									post: postToSlack(slackChannel.value),
								},
							]
						: []),
					...(hazel === null
						? []
						: [
								{
									name: "Hazel" as const,
									postedAttribute: "maple.cancellation.hazel_posted" as const,
									post: postToHazel(hazel),
								},
							]),
				]
				const [primary, ...secondary] = destinations
				if (primary === undefined) return yield* outcome("not_configured")

				// Every region's instance receives the webhook and exactly one may report,
				// so an unanswered region lookup waits for the next delivery.
				const home = yield* regions.servedHere(orgId)
				if (home === "unknown") {
					return yield* new CancellationReviewError({
						message: "Could not tell which region the org lives in",
						step: "region",
					})
				}
				if (home === "deleted") return yield* outcome("org_deleted")
				if (home === "elsewhere") return yield* outcome("other_region")

				// The one required read: it says whether this plan is the org's plan at all.
				const response = yield* autumn
					.getOrCreateCustomer(ownBillingCustomer(orgId), { expand: ["invoices"] })
					.pipe(
						Effect.flatMap(ensureOk),
						Effect.mapError(failedAt("billing", "Could not read the Autumn customer")),
					)
				// Read off the raw response, as the plan gate does: a strict decode that
				// failed would wave every add-on and plan switch through as a cancellation.
				const subscriptions = subscriptionsOf(response)
				const subscription = Arr.findFirst(subscriptions, (sub) => sub.planId === job.planId)
				if (Option.isSome(subscription) && !isPlanSubscription(subscription.value)) {
					return yield* outcome("not_a_plan")
				}
				// An ended plan while the org holds an active one is a switch or a
				// resubscription, not a departure. Asked of Autumn rather than read off the
				// webhook, whose payload cannot tell a replacement plan from an add-on.
				if (job.phase === "ended" && Arr.some(subscriptions, isActivePlanSubscription)) {
					return yield* outcome("still_subscribed")
				}

				const nowMs = yield* Clock.currentTimeMillis
				const claimed = yield* claim(job, nowMs)
				if (claimed.state === "posted") return yield* outcome("duplicate")
				if (claimed.state === "busy") {
					return yield* new CancellationReviewError({
						message: "Another delivery is already reviewing this cancellation",
						step: "claim",
					})
				}

				// The moment the org decided, which for a scheduled cancellation is
				// well before the plan ends.
				const atMs = job.canceledAt ?? job.receivedAt
				// The org and its members first: the company section reads their email domains.
				const [ownOrgId, org] = yield* Effect.all(
					[
						optional("ownOrg", readOwnOrg, ORG_TIMEOUT),
						optional("org", readOrg(orgId), ORG_TIMEOUT),
					],
					{ concurrency: 2 },
				)
				const input: CancellationEvidenceInput = {
					orgId,
					atMs,
					autumnCustomer: response,
					stripeCustomerId: Option.getOrNull(stripeCustomerIdOf(response)),
					ownOrgId,
					members: org?.members ?? null,
				}
				const [
					sessions,
					audit,
					stripeFeedback,
					company,
					billingHistory,
					app,
					telemetry,
					ingest,
					visits,
					adoption,
					billing,
					integrations,
					otherOrgs,
				] = yield* Effect.all(
					[
						// First: the slowest, and the ones the model leans on most.
						optional("sessions", readSessions(orgId, atMs, ownOrgId)),
						optional("auditLog", readAuditLog(orgId, atMs)),
						optional("stripeFeedback", readStripeFeedback(response, atMs)),
						section("company", CancellationCompanyEvidence, companyEvidence.read(input)),
						section("billingHistory", CancellationBillingEvidence, billingEvidence.read(input)),
						section("app", CancellationAppEvidence, appEvidence.read(input)),
						section("telemetry", CancellationTelemetryEvidence, telemetryEvidence.read(input)),
						optional("ingest", readIngest(orgId, atMs)),
						optional("visits", readVisits(orgId, atMs, ownOrgId)),
						optional("adoption", readAdoption(orgId)),
						optional(
							"billing",
							decodeUpstream(CustomerBilling, response).pipe(
								Effect.map(({ balances, invoices }) =>
									summarizeBilling({
										balances: balances ?? {},
										// A review run at the plan's end must not read the invoices after the decision.
										invoices: Arr.filter(invoices ?? [], (invoice) =>
											knownAtCancel(atMs, invoice.createdAt),
										),
									}),
								),
							),
						),
						optional(
							"integrations",
							inventory.list(orgId).pipe(Effect.map((listed) => listed.integrations)),
						),
						org?.members == null
							? Effect.succeed(null)
							: optional("otherOrgs", readOtherOrgs(orgId, org.members)),
					],
					// A Worker keeps six connections open at once, and the sections fan out.
					{ concurrency: 4 },
				)
				const snapshot = new CancellationSnapshot({
					plan: {
						planId: job.planId,
						phase: job.phase,
						trial: job.trial,
						pastDue: job.pastDue,
						tenureDays:
							job.startedAt === null
								? null
								: Math.max(0, Math.floor((atMs - job.startedAt) / DAY_MS)),
						daysUntilEnd:
							job.phase === "ended"
								? 0
								: job.expiresAt === null
									? null
									: Math.max(0, Math.ceil((job.expiresAt - nowMs) / DAY_MS)),
					},
					org:
						org === null
							? null
							: {
									ageDays:
										org.info.createdAtMs === null
											? null
											: Math.max(0, Math.floor((atMs - org.info.createdAtMs) / DAY_MS)),
									members: org.members === null ? null : org.members.length,
									everReceivedData:
										org.state?.firstDataReceivedAt != null ||
										(ingest !== null && ingest.daysSinceLastData !== null),
									supportChannel: org.supportChannels > 0,
								},
					ingest,
					visits,
					adoption,
					billing,
				})

				const reason = ruleReason(snapshot)
				const signals = deriveSignals(snapshot)
				const modelRead = yield* reader.read(
					new CancellationModelRequest({
						snapshot,
						ruleReason: reason,
						signals: Arr.map(signals, (signal) => signal.text),
						stripeFeedback,
						sessions,
						auditLog: audit,
						company,
						billing: billingHistory,
						app,
						telemetry,
						otherOrgs:
							otherOrgs === null || org?.members == null
								? null
								: otherOrgsOf(atMs, otherOrgs, org.members),
					}),
				)
				const report: CancellationReport = {
					subject: {
						orgId,
						orgName: org?.info.name ?? orgId,
						contactEmail: org?.state?.email ?? null,
						expiresAt: job.expiresAt,
						links: orgLinks(orgId, response),
						// The same sessions the model read: this org's, up to the visit it cancelled in.
						sessionsUrl:
							ownOrgId === null
								? null
								: `${Str.replace(/\/+$/, "")(env.MAPLE_APP_BASE_URL)}/replays?${new URLSearchParams(
										{
											groupId: orgId,
											startTime: formatWarehouseDateTime(atMs - WINDOW_DAYS * DAY_MS),
											endTime: formatWarehouseDateTime(atMs + EVIDENCE_GRACE_MS),
										},
									)}`,
						integrations,
						otherOrgs,
					},
					snapshot,
					reason,
					signals,
					modelRead,
					stripeFeedback,
					unreadEvidence: Arr.map(
						Arr.filter(
							Rec.toEntries({
								sessions,
								"audit log": audit,
								Stripe: stripeFeedback,
								company,
								"billing history": billingHistory,
								"app state": app,
								"telemetry detail": telemetry,
							}),
							([, source]) => source === null,
						),
						([name]) => name,
					),
				}

				// The first destination decides whether the review is retried. The rest post once it
				// has settled and are never retried: the retry would post the first one again.
				const delivered = yield* primary.post(report).pipe(
					Effect.timeout(POST_TIMEOUT),
					// A refused or failed post: the retry is this delivery's own and need not wait
					// out its lease. A timed-out one may still land, so the lease keeps the retry
					// from posting it twice right away.
					Effect.tapError((error) =>
						Cause.isTimeoutError(error) ? Effect.void : releaseClaim(claimed.id, nowMs),
					),
					Effect.mapError(
						failedAt("post", `Could not post the cancellation report to ${primary.name}`),
					),
				)
				yield* Effect.annotateCurrentSpan(primary.postedAttribute, delivered)
				const alsoDelivered = yield* Effect.forEach(secondary, (destination) =>
					destination.post(report).pipe(
						Effect.timeout(POST_TIMEOUT),
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logError(
										`Could not post the cancellation report to ${destination.name}; it is not retried`,
									).pipe(
										Effect.annotateLogs({ error: summarizeCause(cause) }),
										Effect.as(false),
									),
						),
						Effect.tap((posted) =>
							Effect.annotateCurrentSpan(destination.postedAttribute, posted),
						),
					),
				)
				if (!delivered && !alsoDelivered.includes(true)) return yield* outcome("refused")

				yield* database
					.execute((db) =>
						db.run(
							PG.update(CancellationReviews)
								.set({
									snapshotJson: snapshot,
									ruleReason: reason,
									modelRead,
									canceledAt: job.canceledAt,
									postedAt: nowMs,
									updatedAt: nowMs,
								})
								.where(($) => [$.id.eq(claimed.id)]),
						),
					)
					.pipe(
						// The report is out. Failing here would redeliver the job and post it again.
						Effect.catchCause((cause) =>
							Effect.logError("cancellation review was posted but not recorded").pipe(
								Effect.annotateLogs({ reviewId: claimed.id, error: summarizeCause(cause) }),
							),
						),
					)

				yield* Effect.annotateCurrentSpan({
					"maple.cancellation.reason": reason,
					"maple.cancellation.model_verdict": modelRead?.verdict ?? "none",
					"maple.cancellation.model_findings": modelRead?.findings.length ?? 0,
					// A report can go out missing sections; this is how that shows on the span.
					"maple.cancellation.unread_sources": Arr.join(
						Arr.map(
							Arr.filter(
								Rec.toEntries({
									org,
									ingest,
									visits,
									adoption,
									billing,
									sessions,
									auditLog: audit,
									stripeFeedback,
									company,
									billingHistory,
									app,
									telemetry,
									otherOrgs,
								}),
								([, section]) => section === null,
							),
							([name]) => name,
						),
						",",
					),
				})
				return yield* outcome("posted")
			},
			// Every log line from one review names the org it is about.
			(effect, job) => Effect.annotateLogs(effect, { orgId: job.orgId, planId: job.planId }),
		)

		return { review } satisfies CancellationReviewServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				SecureRandom.layerWebCrypto,
				OrganizationRegionService.layer,
				OrganizationService.layer,
				OrgMembersService.layer,
				OnboardingService.layer,
				DailySpendService.layer,
				WarehouseQueryService.layer,
				OrgIngestKeysService.layer,
				AutumnClient.layer,
				SupportSlackClient.layer,
				FetchHttpClient.layer,
				IntegrationInventoryService.layer,
				AuditLogService.layer,
				StripeClient.layer,
				CancellationReader.layer,
				CancellationCompanyEvidenceReader.layer,
				CancellationBillingEvidenceReader.layer,
				CancellationAppEvidenceReader.layer,
				CancellationTelemetryEvidenceReader.layer,
			),
		),
	)
}
