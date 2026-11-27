import { AdClickType } from "@maple/db/tables"
import { Duration, Option, Schema, String as Str } from "effect"

/**
 * The ad click a sign-up carried in Clerk's `unsafe_metadata.adClick`, set by the dashboard from
 * the landing site's first-party cookie. The browser writes it, so it is untrusted input.
 */
export const AdClick = Schema.Struct({
	type: AdClickType,
	id: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(256),
		Schema.isPattern(/^[A-Za-z0-9_-]+$/),
	),
	/** Epoch ms of the click. */
	clickTime: Schema.Number.check(Schema.isInt()),
})
export type AdClick = typeof AdClick.Type

const UnsafeMetadata = Schema.Struct({ adClick: Schema.optionalKey(Schema.Unknown) })

/** Google takes conversions up to 90 days after the click. */
export const AD_CLICK_WINDOW = Duration.days(90)
/** Slack for a browser clock ahead of ours. */
const CLOCK_SKEW = Duration.minutes(5)
const RAW_MAX = 300

export type AdClickDecode =
	| { readonly _tag: "Absent" }
	| { readonly _tag: "Valid"; readonly click: AdClick }
	| { readonly _tag: "Invalid"; readonly rawAdClick: string }

const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const rawOf = (value: unknown): string =>
	Str.slice(
		0,
		RAW_MAX,
	)(typeof value === "string" ? value : Option.getOrElse(encodeJson(value), () => String(value)))

/**
 * Read the click from a user's `unsafe_metadata`. A click from outside the window (or the
 * future) is invalid, and a time a little ahead of `nowMs` is pulled back to it.
 */
export const decodeAdClick = (unsafeMetadata: unknown, nowMs: number): AdClickDecode => {
	const metadata = Schema.decodeUnknownOption(UnsafeMetadata)(unsafeMetadata)
	if (Option.isNone(metadata) || metadata.value.adClick === undefined) return { _tag: "Absent" }
	const raw = metadata.value.adClick
	const click = Schema.decodeUnknownOption(AdClick)(raw)
	if (Option.isNone(click)) return { _tag: "Invalid", rawAdClick: rawOf(raw) }
	const { clickTime } = click.value
	const tooOld = clickTime < nowMs - Duration.toMillis(AD_CLICK_WINDOW)
	const future = clickTime > nowMs + Duration.toMillis(CLOCK_SKEW)
	if (tooOld || future) return { _tag: "Invalid", rawAdClick: rawOf(raw) }
	return { _tag: "Valid", click: { ...click.value, clickTime: Math.min(clickTime, nowMs) } }
}
