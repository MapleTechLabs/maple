/**
 * Morph as a cost provider. Morph serves only each member's spend so far this month, so every pull
 * first records that reading, then turns the readings of the window's months into daily rows. The
 * readings are the history: a re-pulled day comes out the same.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { MorphSpendReadings } from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Option, type Redacted, Array as Arr, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import {
	type CostProviderAdapter,
	CostProviderError,
	type CostPull,
	type CostPullSource,
	type CostPullWindow,
} from "../../CostProvider"
import { CostConnectionStore, loadFailureOf } from "../../CostConnectionStore"
import { addDays, historyFloor, maxDay, minDay, monthStart, utcToday } from "../../sync-plan"
import * as MorphBudgets from "./morph-budgets-api"
import { toCostRows } from "./normalize"

type Reason = CostProviderError["reason"]

// Morph does not bill for API requests, so no failure counts any.
const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "morph", reason, requests: 0 })

/** Morph's failures, as what the sync does next and the Cost page shows. */
export const toCostProviderError = (error: MorphBudgets.MorphBudgetsError): CostProviderError => {
	switch (error.kind) {
		case "unauthorized":
			return failed("auth", "Morph rejected the saved key. Replace the key to resume the sync.")
		// The key passed this check when it was saved: its owner is no longer an admin, or the key moved.
		case "forbidden":
			return failed(
				"not_ready",
				"Morph no longer lets the saved key read the organization's spend. Replace it with a key an organization admin owns.",
			)
		case "invalid_response":
			return failed("invalid_response", "Morph's spend answer could not be read.")
		case "rate_limited":
			return failed("rate_limited", "Morph is rate limiting spend requests.")
		default:
			return failed("upstream", "Morph did not answer the spend request.")
	}
}

/** The day a reading taken on `today` counts for: inside the month Morph says the spend covers. */
export const readingDay = (month: string, today: string): string => {
	const first = `${month}-01`
	return maxDay(first, minDay(today, addDays(monthStart(first, 1), -1)))
}

export interface MemberReading {
	readonly memberId: string
	readonly memberLabel: string
	readonly micros: number
}

/** Morph's answer as readings; none when an amount does not fit, which would store a wrong total. */
export const toMemberReadings = (
	list: MorphBudgets.MemberBudgetList,
): Option.Option<ReadonlyArray<MemberReading>> =>
	Option.all(
		Arr.map(list.members, (member) =>
			Option.map(Option.fromUndefinedOr(MorphBudgets.parseMicros(member.spent)), (micros) => ({
				memberId: member.userId,
				memberLabel:
					member.email === undefined || member.email === null || Str.isEmpty(member.email)
						? member.userId
						: member.email,
				micros,
			})),
		),
	)

/**
 * Keeps `readings`, taken at `readAt`, as their day's first and last where they are earlier or
 * later than what is stored. Then drops the months the sync no longer pulls,
 * keeping one more for a pull that started before the floor moved.
 */
export const writeReadings = Effect.fnUntraced(function* (
	db: MapleDb,
	source: CostPullSource,
	month: string,
	readings: ReadonlyArray<MemberReading>,
	readAt: number,
) {
	const day = readingDay(month, utcToday(readAt))
	const keyOf = (reading: MemberReading) =>
		({ connectionId: source.connectionRef, month, memberId: reading.memberId, day }) as const
	const write = (reading: MemberReading) =>
		Effect.gen(function* () {
			const key = keyOf(reading)
			yield* db.run(
				PG.insertInto(MorphSpendReadings)
					.values({
						orgId: source.orgId,
						...key,
						memberLabel: reading.memberLabel,
						openingMicros: reading.micros,
						closingMicros: reading.micros,
						firstReadAt: readAt,
						lastReadAt: readAt,
					})
					.onConflictDoNothing(),
			)
			// Readings can land out of order: each end of the day moves only to a reading beyond it.
			yield* db.run(
				PG.update(MorphSpendReadings)
					.set({
						memberLabel: reading.memberLabel,
						closingMicros: reading.micros,
						lastReadAt: readAt,
					})
					.where(($) => [
						$.connectionId.eq(key.connectionId),
						$.month.eq(key.month),
						$.memberId.eq(key.memberId),
						$.day.eq(key.day),
						$.lastReadAt.lt(readAt),
					]),
			)
			yield* db.run(
				PG.update(MorphSpendReadings)
					.set({ openingMicros: reading.micros, firstReadAt: readAt })
					.where(($) => [
						$.connectionId.eq(key.connectionId),
						$.month.eq(key.month),
						$.memberId.eq(key.memberId),
						$.day.eq(key.day),
						$.firstReadAt.gt(readAt),
					]),
			)
		})
	yield* Effect.forEach(readings, write, { discard: true })
	yield* db.run(
		PG.deleteFrom(MorphSpendReadings).where(($) => [
			$.orgId.eq(source.orgId),
			$.connectionId.eq(source.connectionRef),
			$.month.lt(Str.slice(0, 7)(monthStart(historyFloor("morph", utcToday(readAt)), -1))),
		]),
	)
	return day
})

export class MorphCostProvider extends Context.Service<MorphCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/MorphCostProvider",
	{
		make: Effect.gen(function* () {
			const connections = yield* CostConnectionStore
			const httpClient = yield* HttpClient.HttpClient
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "MorphCostProvider", () =>
				failed("upstream", "Cost connection database error"),
			)

			/** Keeps the reading as its day's last, and as its first when the day has none yet. */
			const record = Effect.fn("MorphCostProvider.record")(function* (
				source: CostPullSource,
				secret: Redacted.Redacted,
			) {
				// Taken before the request: a slow answer must not pass for a newer reading.
				const readAt = yield* Clock.currentTimeMillis
				const list = yield* MorphBudgets.listMemberSpend(httpClient, secret).pipe(
					Effect.mapError(toCostProviderError),
				)
				const readings = yield* Effect.fromOption(toMemberReadings(list)).pipe(
					Effect.mapError(() =>
						failed("invalid_response", "Morph reported a spend Maple cannot read."),
					),
				)
				yield* Effect.annotateCurrentSpan({
					"maple.cost.morph.month": list.month,
					"maple.cost.morph.members": readings.length,
				})
				// One reading's members are kept all or none.
				return yield* dbExecute((db) =>
					db.transaction(writeReadings(db, source, list.month, readings, readAt)),
				)
			})

			const pull = Effect.fn("MorphCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "morph",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					const credential = yield* connections
						.load("morph", source)
						.pipe(Effect.mapError(loadFailureOf("morph")))
					if (Option.isNone(credential)) {
						return yield* failed("auth", "No Morph key is saved for this source.")
					}
					const { secret, accountId } = credential.value
					const openDay = yield* record(source, secret)
					// Whole months: a day's cost is its reading less the one before it in the month.
					const stored = yield* dbExecute((db) =>
						db.run(
							PG.from(MorphSpendReadings)
								.select(($) => ({
									month: $.month,
									day: $.day,
									memberId: $.memberId,
									memberLabel: $.memberLabel,
									openingMicros: $.openingMicros,
									closingMicros: $.closingMicros,
								}))
								.where(($) => [
									$.orgId.eq(source.orgId),
									$.connectionId.eq(source.connectionRef),
									$.month.gte(Str.slice(0, 7)(window.startDay)),
									$.month.lte(Str.slice(0, 7)(window.endDay)),
								]),
						),
					)
					const rows = toCostRows(stored, accountId, window, openDay)
					yield* Effect.annotateCurrentSpan({
						"maple.cost.morph.readings": stored.length,
						"maple.cost.rows": rows.length,
					})
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "morph", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
