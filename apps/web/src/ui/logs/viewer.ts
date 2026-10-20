import { Effect, Option, Schema } from "effect"

/** What a logs view reads from the browser before it renders: the display zone and number locale. */
export const ViewerFlags = Schema.Struct({ timeZone: Schema.String, locale: Schema.String })
export type ViewerFlags = typeof ViewerFlags.Type

// The stored time zone preference, "system" or an IANA zone.
const TIMEZONE_STORAGE_KEY = "maple.preferences.timezone"
const SYSTEM_VALUE = "__system__"

const isValidIanaTimeZone = (zone: string): boolean =>
	zone.trim().length > 0 && Intl.supportedValuesOf("timeZone").includes(zone)

const browserTimeZone = (): string => {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
	return zone && (zone === "UTC" || isValidIanaTimeZone(zone)) ? zone : "UTC"
}

/** `getEffectiveTimezone`: the stored zone (raw or JSON-encoded), else the browser's. */
const storedTimeZone = (raw: string | null): Option.Option<string> =>
	Option.fromNullishOr(raw).pipe(
		Option.map((value) =>
			Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))(value).pipe(
				Option.getOrElse(() => value),
			),
		),
		Option.filter((zone) => zone !== SYSTEM_VALUE && (zone === "UTC" || isValidIanaTimeZone(zone))),
	)

export const viewerFlags: Effect.Effect<ViewerFlags> = Effect.sync(() => ({
	timeZone: Option.getOrElse(storedTimeZone(localStorage.getItem(TIMEZONE_STORAGE_KEY)), browserTimeZone),
	locale: navigator.language,
}))

/** `ListFooter`'s count line. */
export const listFooterText = (
	locale: string,
	options: {
		readonly shown: number
		readonly noun: string
		readonly capped: boolean
		readonly hasMore: boolean
	},
): string => {
	const count = new Intl.NumberFormat(locale).format(options.shown)
	const noun = options.shown === 1 && /[^s]s$/.test(options.noun) ? options.noun.slice(0, -1) : options.noun
	if (options.capped) return `Showing first ${count} ${noun}, narrow the filters to see more`
	if (options.hasMore) return `Showing ${count} ${noun}, more available`
	return `${count} ${noun}`
}
