/**
 * The weekly digest tick both digests run on their own columns of `digest_subscriptions`: pick
 * the subscriptions due now, claim the window once per group, render once per group, send per
 * subscriber, record each send. A parked org, or one whose members' roles could not be read, is
 * skipped before the claim, so it is not marked attempted for the window.
 */
import type { MapleDb, MapleDbError } from "@maple/db/client"
import type { DigestSubscriptionRow } from "@maple/db/tables"
import type { EdgeCacheServiceApi } from "@maple/cache"
import type { AuthorizationUnavailableError, DigestPersistenceError } from "@maple/domain/http"
import { OrgId, UserId } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Cause, Clock, Effect, Option, Array as Arr, Record as Rec } from "effect"
import type { EmailServiceApi } from "@maple/backend/platform/EmailService"
import type { OrgMembershipServiceApi } from "@maple/backend/services/auth/OrgMembershipService"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { runWarehouseOrgTurn } from "@maple/backend/services/warehouse/warehouse-org-quarantine"
import { digestResendCutoffMs, isDigestDue } from "./digest-schedule"
import { type UnsubscribeKind, unsubscribeLinks } from "./unsubscribe-token"

type SubscriptionId = DigestSubscriptionRow["id"]

/**
 * Groups one digest renders per tick. Each costs a dozen subrequests and both digests share one
 * invocation's cap; the rest stay unclaimed for the next 15-minute tick that day.
 */
export const MAX_DIGEST_GROUPS_PER_TICK = 30

/** One digest's columns: who receives it, and when it was last sent and attempted. */
export interface DigestChannel {
	readonly kind: UnsubscribeKind
	readonly selectEnabled: (db: MapleDb) => Effect.Effect<ReadonlyArray<DigestSubscriptionRow>, MapleDbError>
	/** The later of the row's last send and last claimed attempt. */
	readonly lastActivity: (row: DigestSubscriptionRow) => number | null
	/** Stamps the attempt on those not attempted since `cutoffMs`; returns the ids it claimed. */
	readonly claim: (
		db: MapleDb,
		ids: ReadonlyArray<SubscriptionId>,
		nowMs: number,
		cutoffMs: number,
	) => Effect.Effect<ReadonlyArray<{ readonly id: SubscriptionId }>, MapleDbError>
	readonly recordSent: (
		db: MapleDb,
		id: SubscriptionId,
		sentAtMs: number,
	) => Effect.Effect<unknown, MapleDbError>
}

/** One group's email: rendered once per subscriber, only the unsubscribe link differs. */
export interface DigestEmail<E> {
	readonly subject: string
	readonly render: (unsubscribeUrl: string) => Effect.Effect<string, E>
}

export interface WeeklyDigestTickInput<EP, ER, R> {
	readonly channel: DigestChannel
	readonly execute: <A>(
		run: (db: MapleDb) => Effect.Effect<A, MapleDbError>,
	) => Effect.Effect<A, DigestPersistenceError>
	readonly email: EmailServiceApi
	readonly edgeCache: EdgeCacheServiceApi
	readonly linkConfig: Parameters<typeof unsubscribeLinks>[0]
	/** Splits the due subscriptions into groups that share one render; each is one org's. */
	readonly groupBy: (row: DigestSubscriptionRow) => string
	/** The group's email, or `undefined` when there is nothing to say; `head` speaks for the group. */
	readonly prepare: (head: DigestSubscriptionRow) => Effect.Effect<DigestEmail<ER> | undefined, EP, R>
	/** Who still reads telemetry, asked before the claim: a failed lookup leaves the group unclaimed. */
	readonly memberships: OrgMembershipServiceApi
	readonly failureMessage: string
	readonly skipMessage?: string
	readonly logQuarantine?: boolean
}

/**
 * What each of an org's members holds, asked once per org and tick: the daily Clerk sweep lags a
 * role change by up to a day. `undefined` without a directory (self-hosted), where everyone reads.
 */
const orgGrants = (memberships: OrgMembershipServiceApi, orgId: string) =>
	memberships.directory === "none" ? Effect.undefined : memberships.orgGrants(OrgId.make(orgId))

const readsTelemetry = (grants: ReadonlyMap<UserId, Policy.Grants> | undefined, sub: DigestSubscriptionRow) =>
	grants === undefined || Policy.can(grants.get(UserId.make(sub.userId)) ?? [], "telemetry:read")

export const runWeeklyDigestTick = <EP, ER, R>(input: WeeklyDigestTickInput<EP, ER, R>) =>
	Effect.gen(function* () {
		const { channel } = input
		const now = yield* Clock.currentTimeMillis
		const resendCutoffMs = digestResendCutoffMs(now)

		const subs = yield* input.execute(channel.selectEnabled)
		const due = Arr.filter(subs, (s) => isDigestDue(s, channel.lastActivity(s), now))
		const groups = Rec.values(Arr.groupBy(due, input.groupBy))
		// Only renders count against the budget, so quarantined groups ahead in line never starve
		// the rest. The groups run one at a time, so a plain counter is safe.
		let rendered = 0
		let deferred = 0

		const sendTo = (sub: DigestSubscriptionRow, message: DigestEmail<ER>) =>
			Effect.gen(function* () {
				const links = unsubscribeLinks(input.linkConfig, channel.kind, sub.id)
				const html = yield* message.render(links.pageUrl)
				yield* input.email.send(sub.email, message.subject, html, { headers: links.headers })
			}).pipe(
				Effect.tap(() =>
					Clock.currentTimeMillis.pipe(
						Effect.flatMap((sentAt) =>
							input.execute((db) => channel.recordSent(db, sub.id, sentAt)),
						),
						// Already sent: a failed bookkeeping write is not a send failure, and the
						// attempt claim still blocks a same-day resend.
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logWarning("Failed to record digest send").pipe(
										Effect.annotateLogs({
											digest: channel.kind,
											subscriptionId: sub.id,
											orgId: sub.orgId,
											error: summarizeCause(cause),
										}),
									),
						),
					),
				),
				Effect.match({ onSuccess: () => ({ sent: true }), onFailure: () => ({ sent: false }) }),
			)

		// Groups of one org share its lookup, failures included: an outage is asked about once a tick.
		const lookups = new Map<
			string,
			Effect.Effect<ReadonlyMap<UserId, Policy.Grants> | undefined, AuthorizationUnavailableError>
		>()
		const grantsOf = Effect.fnUntraced(function* (orgId: string) {
			const known = lookups.get(orgId)
			if (known !== undefined) return yield* known
			const lookup = yield* Effect.cached(orgGrants(input.memberships, orgId))
			lookups.set(orgId, lookup)
			return yield* lookup
		})

		const results = yield* Effect.forEach(
			groups,
			(group) => {
				const [head] = group
				const skip = Effect.sync(() => {
					deferred++
					return []
				})
				const sendGroup = Effect.gen(function* () {
					// Before the claim: a failed lookup leaves the window open for the next tick.
					const grants = yield* grantsOf(head.orgId).pipe(
						Effect.tapError((error) =>
							Effect.logWarning(
								"Leaving a digest group for the next tick: its members' roles could not be read",
							).pipe(
								Effect.annotateLogs({
									digest: channel.kind,
									orgId: head.orgId,
									error: error.message,
								}),
							),
						),
						Effect.option,
					)
					if (Option.isNone(grants)) return []
					const claim = yield* input.execute((db) =>
						channel.claim(
							db,
							Arr.map(group, (s) => s.id),
							now,
							resendCutoffMs,
						),
					)
					const claimedIds = new Set(Arr.map(claim, (c) => c.id))
					const claimed = Arr.filter(group, (s) => claimedIds.has(s.id))
					if (claimed.length < group.length) {
						yield* Effect.logInfo(
							"Skipping digest subscriptions already attempted this window",
						).pipe(
							Effect.annotateLogs({
								digest: channel.kind,
								orgId: head.orgId,
								skippedCount: group.length - claimed.length,
								claimedCount: claimed.length,
							}),
						)
					}
					const recipients = Arr.filter(claimed, (sub) => readsTelemetry(grants.value, sub))
					if (recipients.length === 0) return []
					rendered++
					const message = yield* input.prepare(head)
					if (message === undefined) return []
					return yield* Effect.forEach(recipients, (sub) => sendTo(sub, message), {
						concurrency: 1,
					})
				})
				const turn = runWarehouseOrgTurn(input.edgeCache, head.orgId, now, sendGroup, {
					skipped: [],
					failed: Effect.sync(() => Arr.map(group, () => ({ sent: false }))),
					failureMessage: input.failureMessage,
					...(input.skipMessage === undefined ? undefined : { skipMessage: input.skipMessage }),
					...(input.logQuarantine === undefined
						? undefined
						: { logQuarantine: input.logQuarantine }),
				})
				return Effect.suspend(() => (rendered >= MAX_DIGEST_GROUPS_PER_TICK ? skip : turn))
			},
			{ concurrency: 1 },
		)

		if (deferred > 0) {
			yield* Effect.logInfo("Deferring digest groups to the next tick").pipe(
				Effect.annotateLogs({ digest: channel.kind, deferredCount: deferred }),
			)
		}

		const all = results.flat()
		const sentCount = Arr.filter(all, (r) => r.sent).length
		return { sentCount, errorCount: all.length - sentCount, groupCount: groups.length }
	})
