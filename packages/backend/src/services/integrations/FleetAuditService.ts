/**
 * Reads each connected Fleet server's activity feed into the audit log: every tick, the
 * activities after the stored cursor, oldest first. A first read starts a week back. The cursor
 * moves per page only once the page is stored, so a failed tick re-reads, and a re-read event
 * writes the same row.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { FleetConnections, type FleetConnectionRow } from "@maple/db/tables"
import { AuditTrailPersistenceError, IntegrationsPersistenceError } from "@maple/domain/http"
import {
	Array as Arr,
	String as Str,
	Clock,
	Context,
	DateTime,
	Effect,
	Layer,
	Option,
	Redacted,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { openSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { fleetTokenSlot } from "@maple/backend/platform/secret-slots"
import { AuditTrailService } from "@maple/backend/services/audit-trail/AuditTrailService"
import { leaseStillOurs } from "./lease"
import { type Lease, type LeaseSpec, leaseFree, withLease } from "./poller"
import { type FleetActivity, fleetActivityToEvent } from "./fleet/activities"
import * as FleetApi from "./fleet/api"
import { fleetServerName } from "@maple/domain/http"

const LEASE_MS = 4 * 60_000
/** How far back a server's first read goes. */
const FIRST_READ_MS = 7 * 24 * 60 * 60_000
const PAGE_SIZE = 500
/** Pages per server per tick; a backlog longer than this drains over the next ticks. */
const MAX_PAGES = 10
/** How many ids before the cursor each read reaches back. */
const OVERLAP_IDS = 20

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Fleet audit poll persistence failure",
)

type FleetLease = Lease<
	FleetConnectionRow,
	PG.UpdateSetOf<typeof FleetConnections>,
	IntegrationsPersistenceError
>

export interface FleetAuditPollResult {
	readonly connections: number
	readonly failedConnections: number
	readonly events: number
}

/** How one server's tick ended. */
type ServerOutcome = { readonly events: number; readonly failed: boolean }

export interface FleetAuditServiceApi {
	readonly pollAll: Effect.Effect<FleetAuditPollResult, IntegrationsPersistenceError>
}

/**
 * The gaps still open after a read: the old ones not filled, plus ids skipped between the
 * previous cursor and the new one, kept while a read can still reach them.
 */
export const gapsAfter = (
	gaps: ReadonlySet<number>,
	written: ReadonlyArray<{ readonly id: number }>,
	cursor: number | null,
	next: number | null,
): ReadonlySet<number> => {
	if (next === null) return new Set()
	const seen = new Set(Arr.map(written, (activity) => activity.id))
	// Only ids a later read can still reach are worth remembering. A first read has no cursor:
	// an id below its lowest may still commit, so the whole reach counts.
	// Fleet ids start at 1, so nothing below that is a gap.
	const from = Math.max(
		1,
		cursor === null ? next - OVERLAP_IDS + 1 : Math.max(cursor + 1, next - OVERLAP_IDS + 1),
	)
	const skipped = from < next ? Arr.range(from, next - 1) : []
	return new Set(
		Arr.filter(
			Arr.appendAll(Arr.fromIterable(gaps), skipped),
			(id) => !seen.has(id) && id > next - OVERLAP_IDS,
		),
	)
}

export class FleetAuditService extends Context.Service<FleetAuditService, FleetAuditServiceApi>()(
	"@maple/backend/services/integrations/FleetAuditService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const trail = yield* AuditTrailService
			const keyring = yield* secretKeyringFromEnv(
				env,
				(message) => new IntegrationsPersistenceError({ message }),
			)
			const dbExecute = makeDbExecute(database, "FleetAuditService", toPersistenceError)

			const fleetLease = (
				connectionId: string,
			): LeaseSpec<
				FleetConnectionRow,
				PG.UpdateSetOf<typeof FleetConnections>,
				IntegrationsPersistenceError
			> => ({
				leaseMs: LEASE_MS,
				claim: (leaseUntil, now) =>
					dbExecute((db) =>
						db.run(
							PG.update(FleetConnections)
								.set({ leaseUntil, updatedAt: now })
								.where(($) => [
									$.id.eq(connectionId),
									$.authFailedAt.isNull(),
									leaseFree($.leaseUntil, $.holdUntil, now, LEASE_MS),
								])
								.returning(),
						),
					).pipe(Effect.map((rows) => rows[0] ?? null)),
				// Only against the token and server this tick read: a reconnect meanwhile keeps its own state.
				write: (claimed, set) =>
					dbExecute((db) =>
						db.run(
							PG.update(FleetConnections)
								.set(set)
								.where(($) => [
									$.id.eq(claimed.id),
									leaseStillOurs($.leaseUntil, claimed.leaseUntil),
									$.tokenCiphertext.eq(claimed.tokenCiphertext),
								])
								.returning("id"),
						),
					).pipe(Effect.map((rows) => rows.length > 0)),
				release: (holdUntil, now) => ({ leaseUntil: null, holdUntil, updatedAt: now }),
				releaseWrite: (claimed, set) =>
					dbExecute((db) =>
						db.run(
							PG.update(FleetConnections)
								.set(set)
								.where(($) => [
									$.id.eq(claimed.id),
									leaseStillOurs($.leaseUntil, claimed.leaseUntil),
								])
								.returning("id"),
						),
					).pipe(Effect.map((rows) => rows.length > 0)),
			})

			const openToken = (row: FleetConnectionRow) =>
				openSecret(
					keyring,
					fleetTokenSlot,
					{ orgId: row.orgId, baseUrl: row.baseUrl },
					{ ciphertext: row.tokenCiphertext, iv: row.tokenIv, tag: row.tokenTag },
					(message) => new IntegrationsPersistenceError({ message }),
				)

			/** Newest-first pages until one reaches `after`, or the page cap: the ids above it, oldest first. */
			const newestBackTo = (
				fleet: FleetApi.FleetClient,
				after: number,
				page: number,
				acc: ReadonlyArray<FleetActivity>,
			): Effect.Effect<ReadonlyArray<FleetActivity>, FleetApi.FleetApiError> =>
				FleetApi.listActivities(fleet, { perPage: PAGE_SIZE, newestFirst: true, page }).pipe(
					Effect.flatMap((answer) => {
						const found = answer.activities ?? []
						const all = Arr.appendAll(
							acc,
							Arr.filter(found, (activity) => activity.id > after),
						)
						const reached =
							found.length < PAGE_SIZE || Arr.some(found, (activity) => activity.id <= after)
						return reached || page + 1 >= MAX_PAGES
							? Effect.succeed(Arr.reverse(all))
							: newestBackTo(fleet, after, page + 1, all)
					}),
				)

			/** Pages after the cursor until the feed is read or the page cap; stores each page before moving on. */
			const readFeed = Effect.fnUntraced(function* (lease: FleetLease, fleet: FleetApi.FleetClient) {
				const { row, now } = lease
				// Host and path: two servers on one host under different paths keep apart.
				const source = {
					account: fleetServerName(row),
					server: Str.replace(/^https:\/\//, "")(row.baseUrl),
				}
				const since = DateTime.formatIso(DateTime.makeUnsafe(now - FIRST_READ_MS))
				const step = (
					cursor: number | null,
					gaps: ReadonlySet<number>,
					pages: number,
					events: number,
				): Effect.Effect<
					number,
					FleetApi.FleetApiError | AuditTrailPersistenceError | IntegrationsPersistenceError
				> =>
					Effect.gen(function* () {
						if (pages >= MAX_PAGES) return events
						// Reaching back over the gaps finds an id that committed after a higher one.
						const after = cursor === null ? null : Math.max(0, cursor - OVERLAP_IDS)
						const page = yield* FleetApi.listActivities(fleet, {
							perPage: PAGE_SIZE,
							...(after === null ? { since } : { after }),
						})
						const asked = page.activities ?? []
						// A server that ignores `after` answers from its oldest id again: past a full page
						// that never reaches the cursor, read newest first back to the cursor instead.
						const ignoresCursor =
							after !== null &&
							asked.length === PAGE_SIZE &&
							Arr.some(asked, (activity) => activity.id <= after)
						const activities = ignoresCursor ? yield* newestBackTo(fleet, after, 0, []) : asked
						// Each event is written once: new ids, and gaps that have now appeared.
						const fresh = Arr.filter(
							activities,
							(activity) => cursor === null || activity.id > cursor,
						)
						const filled = Arr.filter(activities, (activity) => gaps.has(activity.id))
						const toWrite = Arr.appendAll(filled, fresh)
						if (toWrite.length === 0) return events
						yield* trail.write(
							row.orgId,
							Arr.getSomes(
								Arr.map(toWrite, (activity) => fleetActivityToEvent(activity, source)),
							),
						)
						const next =
							fresh.length === 0
								? cursor
								: Math.max(...Arr.map(fresh, (activity) => activity.id))
						const nextGaps = gapsAfter(gaps, toWrite, cursor, next)
						const ours = yield* lease.write({
							activityCursor: next,
							activityGaps: Arr.fromIterable(nextGaps),
							updatedAt: now,
						})
						// Fleet may leave `meta` out of a cursor read: a full page means there may be more.
						const more = page.meta?.has_next_results === true || asked.length === PAGE_SIZE
						if (!ours || fresh.length === 0 || ignoresCursor || !more)
							return events + toWrite.length
						return yield* step(next, nextGaps, pages + 1, events + toWrite.length)
					})
				return yield* step(row.activityCursor, new Set(row.activityGaps ?? []), 0, 0)
			})

			const pollClaimed = Effect.fn("FleetAuditService.pollServer")(function* (lease: FleetLease) {
				const { row, now } = lease
				yield* Effect.annotateCurrentSpan({ orgId: row.orgId, "maple.fleet.connection_id": row.id })
				const failWith = (message: string, extra: PG.UpdateSetOf<typeof FleetConnections> = {}) =>
					lease
						.write({ lastError: message, lastErrorAt: now, updatedAt: now, ...extra })
						.pipe(Effect.as<ServerOutcome>({ events: 0, failed: true }))

				const token = yield* Effect.result(openToken(row))
				if (token._tag === "Failure")
					return yield* failWith("The stored Fleet token could not be opened. Save it again.")
				const read = yield* Effect.result(
					FleetApi.fleetClient(httpClient, {
						baseUrl: row.baseUrl,
						token: Redacted.make(token.success),
					}).pipe(Effect.flatMap((fleet) => readFeed(lease, fleet))),
				)
				if (read._tag === "Success") {
					yield* Effect.annotateCurrentSpan("maple.fleet.events", read.success)
					yield* lease.write({
						lastSuccessAt: now,
						lastError: null,
						lastErrorAt: null,
						updatedAt: now,
					})
					return { events: read.success, failed: false } satisfies ServerOutcome
				}
				const failure = read.failure
				yield* Effect.annotateCurrentSpan("maple.fleet.error", failure._tag)
				if (failure._tag !== "@maple/backend/integrations/FleetApiError")
					return yield* failWith(
						"Fleet activity was read but could not be stored. Maple retries next tick.",
					)
				yield* Effect.annotateCurrentSpan("maple.fleet.error_kind", failure.kind)
				switch (failure.kind) {
					// Polling stops until a new token is saved.
					case "unauthorized":
						return yield* failWith(failure.message, { authFailedAt: now })
					case "rate_limited":
						yield* lease.holdFor({
							_tag: "RateLimited",
							message: failure.message,
							retryAfterMs: (failure.retryAfterSeconds ?? 0) * 1000,
						})
						return yield* failWith(failure.message)
					default:
						return yield* failWith(failure.message)
				}
			})

			const pollAll = Effect.gen(function* () {
				const candidates = yield* dbExecute((db) =>
					db.run(
						PG.from(FleetConnections)
							.select("id")
							.where(($) => [$.authFailedAt.isNull()]),
					),
				)
				const outcomes = yield* Effect.forEach(
					candidates,
					(candidate) =>
						// Each server's own clock: servers run four at a time and one can take minutes.
						Clock.currentTimeMillis.pipe(
							Effect.flatMap((now) => withLease(fleetLease(candidate.id), now, pollClaimed)),
							// One server's broken row never stops the others.
							Effect.catch((error) =>
								Effect.logWarning("Fleet audit poll failed").pipe(
									Effect.annotateLogs({ connectionId: candidate.id, error }),
									Effect.as(Option.some<ServerOutcome>({ events: 0, failed: true })),
								),
							),
						),
					{ concurrency: 4 },
				)
				const polled = Arr.getSomes(outcomes)
				return {
					connections: polled.length,
					failedConnections: Arr.filter(polled, (outcome) => outcome.failed).length,
					events: Arr.reduce(polled, 0, (sum, outcome) => sum + outcome.events),
				} satisfies FleetAuditPollResult
			}).pipe(Effect.withSpan("FleetAuditService.pollAll"))

			return { pollAll } satisfies FleetAuditServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(AuditTrailService.layer),
		Layer.provide(FetchHttpClient.layer),
	)
}
