import { readLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Option, Schema } from "effect"

// copied: apps/web/src/atoms/timezone-preference-atoms.ts (`getEffectiveTimezone`); that module
// builds an effect-atom KVS, so it cannot be imported here.
const TIMEZONE_STORAGE_KEY = "maple.preferences.timezone"
const SYSTEM_VALUE = "__system__"
const DEFAULT_TIMEZONE = "UTC"

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

const isValidZone = (zone: string): Effect.Effect<boolean> =>
	zone.trim().length === 0
		? Effect.succeed(false)
		: Effect.try(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date())).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			)

const browserZone: Effect.Effect<string> = Effect.try(
	() => Intl.DateTimeFormat().resolvedOptions().timeZone,
).pipe(
	Effect.flatMap((zone) => Effect.map(isValidZone(zone), (valid) => (valid ? zone : DEFAULT_TIMEZONE))),
	Effect.orElseSucceed(() => DEFAULT_TIMEZONE),
)

/** The stored zone preference resolved like legacy: system, or an invalid zone, means the browser's. */
export const readEffectiveTimeZone: Effect.Effect<string> = Effect.gen(function* () {
	const stored = Option.map(readLocalStorage(TIMEZONE_STORAGE_KEY), (raw) =>
		Option.getOrElse(decodeStored(raw), () => raw),
	)
	if (Option.isNone(stored) || stored.value === SYSTEM_VALUE) return yield* browserZone
	return (yield* isValidZone(stored.value)) ? stored.value : yield* browserZone
})
