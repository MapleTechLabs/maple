import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Option, Schema, String as Str } from "effect"

/** The list footer's count line. */
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
	const noun =
		options.shown === 1 && /[^s]s$/.test(options.noun) ? Str.slice(0, -1)(options.noun) : options.noun
	if (options.capped) return `Showing first ${count} ${noun}, narrow the filters to see more`
	if (options.hasMore) return `Showing ${count} ${noun}, more available`
	return `${count} ${noun}`
}

export const Density = Schema.Literals(["compact", "comfortable"])
export type Density = typeof Density.Type

/** Line wrapping and row density, kept per browser. */
export const LogsViewPreferences = Schema.Struct({ wrap: Schema.Boolean, density: Density })
export type LogsViewPreferences = typeof LogsViewPreferences.Type

const WRAP_KEY = "maple.logs.wrap"
const DENSITY_KEY = "maple.logs.density"
const decodeWrap = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Boolean))
const decodeDensity = Schema.decodeUnknownOption(Schema.fromJsonString(Density))
const encodeWrap = Schema.encodeSync(Schema.fromJsonString(Schema.Boolean))
const encodeDensity = Schema.encodeSync(Schema.fromJsonString(Density))

/** The `Atom.kvs` preferences (JSON in localStorage); unreadable ones fall back to the defaults. */
export const readLogsViewPreferences: Effect.Effect<LogsViewPreferences> = Effect.sync(() => ({
	wrap: Option.getOrElse(Option.flatMap(readLocalStorage(WRAP_KEY), decodeWrap), () => false),
	density: Option.getOrElse(
		Option.flatMap(readLocalStorage(DENSITY_KEY), decodeDensity),
		(): Density => "compact",
	),
}))

export const saveLogsViewPreferences = (preferences: LogsViewPreferences): Effect.Effect<void> =>
	Effect.sync(() => {
		writeLocalStorage(WRAP_KEY, encodeWrap(preferences.wrap))
		writeLocalStorage(DENSITY_KEY, encodeDensity(preferences.density))
	})
