import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Option, Schema } from "effect"

// The stored time zone preference.
export const TIMEZONE_STORAGE_KEY = "maple.preferences.timezone"
export const SYSTEM_VALUE = "__system__"
const DEFAULT_TIMEZONE = "UTC"

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

const isValidZone = (zone: string): Effect.Effect<boolean> =>
	zone.trim().length === 0
		? Effect.succeed(false)
		: Effect.try(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date())).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			)

export const browserZone: Effect.Effect<string> = Effect.try(
	() => Intl.DateTimeFormat().resolvedOptions().timeZone,
).pipe(
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
		writeLocalStorage(TIMEZONE_STORAGE_KEY, JSON.stringify(Option.getOrElse(selected, () => SYSTEM_VALUE)))
		window.dispatchEvent(new Event(TIME_ZONE_PREFERENCE_EVENT))
	})

const supportedValues = Option.liftThrowable(() => Intl.supportedValuesOf("timeZone"))

/** `listSupportedTimeZones`: every zone the runtime knows, else UTC and the browser's own. */
export const readSupportedTimeZones: Effect.Effect<ReadonlyArray<string>> = Effect.map(browserZone, (browser) =>
	Option.getOrElse(
		Option.filter(supportedValues(), (values) => values.length > 0),
		() => [...new Set(["UTC", browser])],
	),
)
