import { AD_CLICK_COOKIE, AdClickId, AdClickType } from "@maple/domain/ad-click"
import { Array as Arr, Option, Schema, String as Str } from "effect"

/**
 * The ad click the landing site kept in the `maple_ad_click` cookie (`<type>.<id>.<clickTimeMs>`),
 * handed to Clerk sign-up as `unsafeMetadata.adClick` so the API can report the conversion.
 */
export { AD_CLICK_COOKIE }

const AdClickMetadata = Schema.Struct({
	type: AdClickType,
	id: AdClickId,
	clickTime: Schema.NumberFromString.check(Schema.isInt()),
})
export type AdClickMetadata = typeof AdClickMetadata.Type

const decodeClick = Schema.decodeUnknownOption(AdClickMetadata)

const parseValue = (value: string): Option.Option<AdClickMetadata> => {
	const parts = Str.split(".")(value)
	if (parts.length !== 3) return Option.none()
	return decodeClick({ type: parts[0], id: parts[1], clickTime: parts[2] })
}

/** The click in a `document.cookie` string, when there is a readable one. */
export const readAdClick = (cookieHeader: string): Option.Option<AdClickMetadata> =>
	Arr.findFirst(Str.split(";")(cookieHeader), (pair) => {
		const trimmed = Str.trim(pair)
		const prefix = `${AD_CLICK_COOKIE}=`
		return Str.startsWith(prefix)(trimmed) ? parseValue(Str.slice(prefix.length)(trimmed)) : Option.none()
	})

/** Expire the cookie on both the shared domain and this host (Global Privacy Control). */
export const clearAdClickCookies = (hostname: string): ReadonlyArray<string> => [
	`${AD_CLICK_COOKIE}=; Max-Age=0; Path=/`,
	...(hostname === "maple.dev" || Str.endsWith(".maple.dev")(hostname)
		? [`${AD_CLICK_COOKIE}=; Max-Age=0; Path=/; Domain=maple.dev`]
		: []),
]
