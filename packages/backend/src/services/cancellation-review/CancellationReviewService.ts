/**
 * The cancellation review: one cancelled subscription in, one Slack report out.
 *
 * Gathers what the org's own usage looks like around the cancellation, reads it
 * with fixed rules and with the decision model, and posts both to Maple's own
 * workspace. Every source but Autumn is optional: a section that cannot be read
 * is `null` in the snapshot and named in the report, because a report missing
 * its visit numbers is worth more than no report.
 */
import {
	alertDestinations,
	alertRules,
	apiKeys,
	cancellationReviews,
	chatWorkspaces,
	dashboards,
	investigations,
	oauthConnections,
	orgSupportChannels,
	vcsInstallations,
} from "@maple/db"
import { isActivePlanSubscription, isPlanSubscription } from "@maple/domain/billing"
import { CancellationSnapshot, type OrgId } from "@maple/domain/http"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"
import { Cause, Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { msToDate } from "@maple/backend/platform/time"
import { systemTenant } from "@maple/backend/services/alerts/system-tenant"
import { decodeUpstream, ensureOk, subscriptionsOf } from "@maple/backend/services/billing/autumn-client"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { DailySpendService } from "@maple/backend/services/billing/DailySpendService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { SupportSlackClient } from "@maple/backend/services/support/SupportSlackClient"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { CancellationAssessor } from "./CancellationAssessor"
import type { CancellationReviewJob } from "./CancellationReviewQueue"
import { deriveSignals, ruleReason } from "./signals"
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

/** A failure worth another delivery: Clerk, Autumn, Postgres or Slack did not answer. */
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
	/** The org lives on another region's instance, which reports it. */
	| "other_region"
	/** An add-on going away is not the org leaving. */
	| "not_a_plan"
	/** The plan ended but the org still holds an active one: a switch or a resubscription. */
	| "still_subscribed"
	/** No Slack channel or bot token on this deployment. */
	| "not_configured"

export interface CancellationReviewServiceApi {
	readonly review: (
		job: CancellationReviewJob,
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

/** The upstream's own words, so the consumer's log says why and not only where. */
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
		const ingestKeys = yield* OrgIngestKeysService
		const autumn = yield* AutumnClient
		const assessor = yield* CancellationAssessor
		const slack = yield* SupportSlackClient

		/** A source that could not be read is `null` in the report, never the end of it. */
		const optional = <A, E>(name: string, read: Effect.Effect<A, E>): Effect.Effect<A | null> =>
			read.pipe(
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

		const count = (table: PgTable, where: SQL | undefined) =>
			database
				.execute((db) =>
					db
						.select({ count: sql<number>`count(*)::int` })
						.from(table)
						.where(where),
				)
				.pipe(Effect.map((rows) => rows[0]?.count ?? 0))

		const readOrg = (orgId: OrgId) =>
			Effect.all(
				{
					info: organizations.retrieve(orgId),
					// Clerk-less deployments have no member directory; the count is then unknown.
					members: members.listMembers(orgId).pipe(
						Effect.map((list): number | null => list.length),
						Effect.orElseSucceed(() => null),
					),
					state: onboarding.findState(orgId).pipe(Effect.map(Option.getOrNull)),
					supportChannels: count(
						orgSupportChannels,
						and(eq(orgSupportChannels.orgId, orgId), isNotNull(orgSupportChannels.slackChannelId)),
					),
				},
				{ concurrency: 4 },
			)

		const readAdoption = (orgId: OrgId) =>
			Effect.all(
				{
					dashboards: count(dashboards, eq(dashboards.orgId, orgId)),
					alertRules: count(alertRules, eq(alertRules.orgId, orgId)),
					alertDestinations: count(alertDestinations, eq(alertDestinations.orgId, orgId)),
					apiKeys: count(apiKeys, and(eq(apiKeys.orgId, orgId), eq(apiKeys.revoked, false))),
					investigations: count(investigations, eq(investigations.orgId, orgId)),
					oauth: count(
						oauthConnections,
						and(eq(oauthConnections.orgId, orgId), isNull(oauthConnections.revokedAt)),
					),
					vcs: count(
						vcsInstallations,
						and(eq(vcsInstallations.orgId, orgId), eq(vcsInstallations.status, "active")),
					),
					chat: count(chatWorkspaces, eq(chatWorkspaces.orgId, orgId)),
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
		 * The org's people in Maple's own app. Those page views are product events
		 * of the org Maple reports its own usage under, tagged with the customer's
		 * org as `GroupId`; that org is whichever one owns the product-events key.
		 */
		const readVisits = Effect.fn("CancellationReviewService.readVisits")(function* (
			orgId: OrgId,
			atMs: number,
		) {
			const key = Option.orElse(env.MAPLE_PRODUCT_EVENTS_INGEST_KEY, () => env.MAPLE_INGEST_KEY)
			if (Option.isNone(key)) return null
			const own = yield* ingestKeys.resolveIngestKey(Redacted.value(key.value))
			if (Option.isNone(own)) return null
			const window = visitsWindow(atMs)
			const pageViews = (groupIds: ReadonlyArray<string> | undefined, bucketSeconds: number) =>
				warehouse.compiledQuery(
					systemTenant(own.value.orgId),
					CH.compile(
						CH.productEventsTimeseriesQuery({
							metric: "users",
							sources: ["browser"],
							bucketSeconds,
							...(groupIds === undefined ? undefined : { groupIds }),
						}),
						{
							orgId: own.value.orgId,
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
					yield* Effect.logWarning("cancellation review found no app page views under the product-events key's org")
					return null
				}
			}
			return summarizeVisits(
				rows.map((row) => ({ dayMs: parseWarehouseDateTime(row.bucket), users: row.value })),
				atMs,
			)
		})

		/**
		 * The row that makes this subscription's review happen once. Autumn may
		 * send no start; the cancellation's own timestamp then names it, which a
		 * scheduled cancellation and its later expiry still share.
		 */
		const claim = (job: CancellationReviewJob, nowMs: number) =>
			database
				.execute((db) =>
					Effect.gen(function* () {
						const subscriptionStartedAt = job.startedAt ?? job.canceledAt ?? 0
						const inserted = yield* db
							.insert(cancellationReviews)
							.values({
								id: crypto.randomUUID(),
								orgId: job.orgId,
								planId: job.planId,
								subscriptionStartedAt,
								canceledAt: job.canceledAt,
								createdAt: msToDate(nowMs),
								updatedAt: msToDate(nowMs),
							})
							.onConflictDoNothing()
							.returning({ id: cancellationReviews.id })
						if (inserted[0] !== undefined) return { id: inserted[0].id, posted: false }
						const [existing] = yield* db
							.select({
								id: cancellationReviews.id,
								postedAt: cancellationReviews.postedAt,
								canceledAt: cancellationReviews.canceledAt,
							})
							.from(cancellationReviews)
							.where(
								and(
									eq(cancellationReviews.orgId, job.orgId),
									eq(cancellationReviews.planId, job.planId),
									eq(cancellationReviews.subscriptionStartedAt, subscriptionStartedAt),
								),
							)
							.limit(1)
						if (existing === undefined) return undefined
						// Cancelled, kept after all, then cancelled again: a new decision on
						// the same subscription, and the one that counts.
						const cancelledAgain =
							job.phase === "scheduled" &&
							job.canceledAt !== null &&
							existing.canceledAt !== null &&
							job.canceledAt > existing.canceledAt
						return { id: existing.id, posted: existing.postedAt !== null && !cancelledAgain }
					}),
				)
				.pipe(Effect.mapError(failedAt("claim", "Could not claim the cancellation review")))

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

				const channel = env.MAPLE_CANCELLATION_SLACK_CHANNEL_ID
				if (Option.isNone(channel) || !slack.configured) {
					if (Option.isSome(channel)) {
						yield* Effect.logWarning(
							"cancellation reviews have a channel but no Slack bot token; nothing is posted",
						)
					}
					return yield* outcome("not_configured")
				}

				// Every region's instance receives the webhook and exactly one may report,
				// so an unanswered region lookup waits for the next delivery.
				const servedHere = yield* regions.servedHere(orgId)
				if (Option.isNone(servedHere)) {
					return yield* new CancellationReviewError({
						message: "Could not tell which region the org lives in",
						step: "region",
					})
				}
				if (!servedHere.value) return yield* outcome("other_region")

				// The one required read: it says whether this plan is the org's plan at all.
				const response = yield* autumn
					.getOrCreateCustomer(orgId, { expand: ["invoices"] })
					.pipe(
						Effect.flatMap(ensureOk),
						Effect.mapError(failedAt("billing", "Could not read the Autumn customer")),
					)
				// Read off the raw response, as the plan gate does: a strict decode that
				// failed would wave every add-on and plan switch through as a cancellation.
				const subscriptions = subscriptionsOf(response)
				const subscription = subscriptions.find((sub) => sub.planId === job.planId)
				if (subscription !== undefined && !isPlanSubscription(subscription)) {
					return yield* outcome("not_a_plan")
				}
				// An ended plan while the org holds an active one is a switch or a
				// resubscription, not a departure. Asked of Autumn rather than read off the
				// webhook, whose payload cannot tell a replacement plan from an add-on.
				if (job.phase === "ended" && subscriptions.some(isActivePlanSubscription)) {
					return yield* outcome("still_subscribed")
				}

				const nowMs = yield* Clock.currentTimeMillis
				const claimed = yield* claim(job, nowMs)
				if (claimed === undefined || claimed.posted) return yield* outcome("duplicate")

				// The moment the org decided, which for a scheduled cancellation is
				// well before the plan ends.
				const atMs = job.canceledAt ?? job.receivedAt
				const [org, ingest, visits, adoption, billing] = yield* Effect.all(
					[
						optional("org", readOrg(orgId)),
						optional("ingest", readIngest(orgId, atMs)),
						optional("visits", readVisits(orgId, atMs)),
						optional("adoption", readAdoption(orgId)),
						optional(
							"billing",
							decodeUpstream(CustomerBilling, response).pipe(
								Effect.map(({ balances, invoices }) =>
									summarizeBilling({ balances: balances ?? {}, invoices: invoices ?? [] }),
								),
							),
						),
					],
					{ concurrency: 3 },
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
									members: org.members,
									onboardingCompleted: org.state?.onboardingCompletedAt != null,
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
				const assessment = yield* assessor.assess(snapshot)
				const message = buildCancellationMessage({
					subject: {
						orgId,
						orgName: org?.info.name ?? orgId,
						contactEmail: org?.state?.email ?? null,
						expiresAt: job.expiresAt,
					},
					snapshot,
					ruleReason: reason,
					signals: deriveSignals(snapshot),
					assessment,
				})

				yield* slack
					.call("chat.postMessage", {
						channel: channel.value,
						text: message.text,
						blocks: JSON.stringify(message.blocks),
						unfurl_links: false,
					})
					.pipe(Effect.mapError(failedAt("post", "Could not post the cancellation report to Slack")))

				yield* database
					.execute((db) =>
						db
							.update(cancellationReviews)
							.set({
								snapshotJson: snapshot,
								ruleReason: reason,
								assessmentJson: assessment,
								canceledAt: job.canceledAt,
								postedAt: msToDate(nowMs),
								updatedAt: msToDate(nowMs),
							})
							.where(eq(cancellationReviews.id, claimed.id)),
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
					"maple.cancellation.rule_reason": reason,
					"maple.cancellation.model_reason": assessment?.reason ?? "none",
					// A report can go out missing sections; this is how that shows on the span.
					"maple.cancellation.unread_sources": Object.entries({ org, ingest, visits, adoption, billing })
						.filter(([, section]) => section === null)
						.map(([name]) => name)
						.join(","),
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
				OrganizationRegionService.layer,
				OrganizationService.layer,
				OrgMembersService.layer,
				OnboardingService.layer,
				DailySpendService.layer,
				WarehouseQueryService.layer,
				OrgIngestKeysService.layer,
				AutumnClient.layer,
				CancellationAssessor.layer,
				SupportSlackClient.layer,
			),
		),
	)
}
