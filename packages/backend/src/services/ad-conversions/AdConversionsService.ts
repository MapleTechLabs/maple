import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AdClickErasures, AdConversions } from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
import type { UserId } from "@maple/domain/http"
import { Array as Arr, Clock, Context, Duration, Effect, Layer, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { AD_CLICK_WINDOW, type AdClick } from "./ad-click"
import type { ExportableConversion } from "./google-ads-csv"

export class AdConversionPersistenceError extends Schema.TaggedError<AdConversionPersistenceError>()(
	"@maple/backend/ad-conversions/AdConversionPersistenceError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
) {}

/**
 * Conversions of people who arrived from an ad click, for the Google Ads scheduled upload.
 * Every write is keyed by (user, conversion), so a retry or a second caller cannot count twice.
 */
export class AdConversionsService extends Context.Service<AdConversionsService>()(
	"@maple/backend/services/AdConversionsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(
				database,
				"AdConversionsService",
				makePersistenceErrorMapper(AdConversionPersistenceError, "Ad conversion persistence error"),
			)

			// Sign-up, activation and erasure take the same per-user lock, so no click lands after an erasure.
			const lockUser = (db: MapleDb, userId: UserId) =>
				db.execute(
					Orm.sql`select pg_advisory_xact_lock(hashtext(${userId}), hashtext('ad_conversions'))`,
				)

			/** The sign-up of a user whose sign-up carried an ad click, unless the user is already deleted. */
			const recordSignup = Effect.fn("AdConversionsService.recordSignup")(function* (
				userId: UserId,
				click: AdClick,
				convertedAt: number,
			) {
				yield* Effect.annotateCurrentSpan({ "maple.ad_click.type": click.type })
				const recorded = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockUser(db, userId)
							const erased = yield* db.run(
								PG.from(AdClickErasures)
									.select(($) => ({ userId: $.userId }))
									.where(($) => [$.userId.eq(userId)])
									.limit(1),
							)
							if (erased.length > 0) return false
							const inserted = yield* db.run(
								PG.insertInto(AdConversions)
									.values({
										userId,
										conversion: "signup",
										clickType: click.type,
										clickId: click.id,
										clickAt: click.clickTime,
										convertedAt,
									})
									.onConflictDoNothing()
									.returning(($) => ({ userId: $.userId })),
							)
							return inserted.length > 0
						}),
					),
				)
				yield* Effect.annotateCurrentSpan({ "maple.ad_conversion.recorded": recorded })
			})

			/** Activation, for a user with a recorded ad sign-up; returns whether one was recorded. */
			const recordActivation = Effect.fn("AdConversionsService.recordActivation")(function* (
				userId: UserId,
				convertedAt: number,
			) {
				const inserted = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockUser(db, userId)
							const signups = yield* db.run(
								PG.from(AdConversions)
									.select()
									.where(($) => [$.userId.eq(userId), $.conversion.eq("signup")])
									.limit(1),
							)
							const signup = signups[0]
							if (signup === undefined) return []
							return yield* db.run(
								PG.insertInto(AdConversions)
									.values({
										userId,
										conversion: "activated",
										clickType: signup.clickType,
										clickId: signup.clickId,
										clickAt: signup.clickAt,
										convertedAt: Math.max(convertedAt, signup.convertedAt),
									})
									.onConflictDoNothing()
									.returning(($) => ({ userId: $.userId })),
							)
						}),
					),
				)
				yield* Effect.annotateCurrentSpan({ "maple.ad_conversion.recorded": inserted.length > 0 })
				return inserted.length > 0
			})

			/** Conversions whose click is still inside Google's 90-day window, oldest first. */
			const listForExport = Effect.fn("AdConversionsService.listForExport")(function* (nowMs: number) {
				const since = nowMs - Duration.toMillis(AD_CLICK_WINDOW)
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(AdConversions)
							.select()
							.where(($) => [$.clickAt.gte(since)])
							.orderBy(["convertedAt", "asc"], ["userId", "asc"], ["conversion", "asc"]),
					),
				)
				yield* Effect.annotateCurrentSpan({ "result.rows": rows.length })
				return Arr.map(rows, (row): ExportableConversion => ({
					conversion: row.conversion,
					clickType: row.clickType,
					clickId: row.clickId,
					convertedAt: row.convertedAt,
				}))
			})

			/** A deleted user's clicks go with them, and none is stored for them again. */
			const forgetUser = Effect.fn("AdConversionsService.forgetUser")(function* (userId: UserId) {
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockUser(db, userId)
							yield* db.run(
								PG.insertInto(AdClickErasures)
									.values({ userId, erasedAt: now })
									.onConflictDoNothing(),
							)
							yield* db.run(PG.deleteFrom(AdConversions).where(($) => [$.userId.eq(userId)]))
						}),
					),
				)
			})

			return { recordSignup, recordActivation, listForExport, forgetUser }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
