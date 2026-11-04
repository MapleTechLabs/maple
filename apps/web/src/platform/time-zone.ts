import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Option, Schema, String as Str } from "effect"

// The stored time zone preference.
export const TIMEZONE_STORAGE_KEY = "maple.preferences.timezone"
export const SYSTEM_VALUE = "__system__"
const DEFAULT_TIMEZONE = "UTC"

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))
const encodeStored = Schema.encodeSync(Schema.fromJsonString(Schema.String))

export class TimeZoneError extends Schema.TaggedError<TimeZoneError>()("@maple/web/TimeZoneError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

const isValidZone = (zone: string): Effect.Effect<boolean> =>
	Str.trim(zone).length === 0
		? Effect.succeed(false)
		: Effect.try({
				try: () => new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0),
				catch: (cause) => new TimeZoneError({ message: `Unknown time zone ${zone}`, cause }),
			}).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			)

export const browserZone: Effect.Effect<string> = Effect.try({
	try: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
	catch: (cause) => new TimeZoneError({ message: "Could not read the browser time zone", cause }),
}).pipe(
	Effect.flatMap((zone) => Effect.map(isValidZone(zone), (valid) => (valid ? zone : DEFAULT_TIMEZONE))),
	Effect.orElseSucceed(() => DEFAULT_TIMEZONE),
)

/** `useTimezonePreference().selectedTimezone`: a valid stored zone, none for system. */
export const readSelectedTimeZone: Effect.Effect<Option.Option<string>> = Effect.gen(function* () {
	const stored = Option.map(readLocalStorage(TIMEZONE_STORAGE_KEY), (raw) =>
		Option.getOrElse(decodeStored(raw), () => raw),
	)
	if (Option.isNone(stored) || stored.value === SYSTEM_VALUE) return Option.none()
	return (yield* isValidZone(stored.value)) ? stored : Option.none()
})

/** The stored zone preference resolved: system, or an invalid zone, means the browser's. */
export const readEffectiveTimeZone: Effect.Effect<string> = Effect.flatMap(readSelectedTimeZone, (selected) =>
	Option.match(selected, { onNone: () => browserZone, onSome: Effect.succeed }),
)

/** This tab's own preference writes; another tab's arrive as `storage` events on the key. */
export const TIME_ZONE_PREFERENCE_EVENT = "maple:timezone-preference"

/**
 * `setSelectedTimezone`: `timezonePreferenceAtom` writes the JSON-encoded zone, `__system__` for
 * none, then every reader re-renders (here: the root hears `TIME_ZONE_PREFERENCE_EVENT`).
 */
export const writeSelectedTimeZone = (selected: Option.Option<string>): Effect.Effect<void> =>
	Effect.sync(() => {
		writeLocalStorage(TIMEZONE_STORAGE_KEY, encodeStored(Option.getOrElse(selected, () => SYSTEM_VALUE)))
		window.dispatchEvent(new Event(TIME_ZONE_PREFERENCE_EVENT))
	})

const zoneFormat = Option.liftThrowable(
	(zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone }),
)

/** An untrusted zone (a URL param) when the runtime knows it; never throws. */
export const validTimeZone = (zone: string): Option.Option<string> =>
	Str.trim(zone).length === 0 ? Option.none() : Option.as(zoneFormat(zone), zone)

const supportedValues = Option.liftThrowable(() => Intl.supportedValuesOf("timeZone"))

/** `listSupportedTimeZones`: every zone the runtime knows, else UTC and the browser's own. */
export const readSupportedTimeZones: Effect.Effect<ReadonlyArray<string>> = Effect.map(
	browserZone,
	(browser) =>
		Option.getOrElse(
			Option.filter(supportedValues(), (values) => values.length > 0),
			() => [...new Set(["UTC", browser])],
		),
)
