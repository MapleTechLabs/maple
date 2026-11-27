import * as PG from "@maple-dev/effect-orm/postgres"
import { UserId } from "@maple/primitives"
import { Schema } from "effect"

/** The click id an ad link carried: `gclid` on most clicks, `gbraid`/`wbraid` from iOS. */
export const AdClickType = Schema.Literals(["gclid", "gbraid", "wbraid"])
export type AdClickType = typeof AdClickType.Type

/** The conversions reported back to the ad platform. */
export const AdConversionName = Schema.Literals(["signup", "activated"])
export type AdConversionName = typeof AdConversionName.Type

/**
 * One conversion of a person who arrived from an ad click, keyed by (user, conversion) so a
 * retried webhook or a second first-data stamp cannot count twice. User-scoped: the click
 * belongs to the person, not an org. Google Ads fetches these as a scheduled CSV upload.
 */
export const AdConversions = PG.table("ad_conversions", {
	columns: {
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		conversion: PG.brand(PG.text, AdConversionName),
		clickType: PG.column(PG.brand(PG.text, AdClickType), { name: "click_type" }),
		clickId: PG.column(PG.text, { name: "click_id" }),
		clickAt: PG.column(PG.timestamptzMillis, { name: "click_at" }),
		convertedAt: PG.column(PG.timestamptzMillis, { name: "converted_at" }),
	},
	primaryKey: ["userId", "conversion"],
	indexes: [PG.index("ad_conversions_click_at_idx", ["clickAt"])],
})
export type AdConversionRow = PG.SelectRowOf<typeof AdConversions>

/**
 * Users whose account was deleted, so a `user.created` delivered after `user.deleted` cannot
 * store their click again. Holds only the Clerk user id.
 */
export const AdClickErasures = PG.table("ad_click_erasures", {
	columns: {
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		erasedAt: PG.column(PG.timestamptzMillis, { name: "erased_at" }),
	},
	primaryKey: ["userId"],
})
