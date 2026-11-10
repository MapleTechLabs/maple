import { Option, String as Str } from "effect"
import { trySync } from "./try-sync"

const DEFAULT_TIMEZONE = "UTC"

// Whether a zone name is one the runtime knows never changes, and asking is
// not cheap — building a formatter and running it. Every timestamp the app
// prints resolves its zone through here, which on a virtualized list is once
// per row per render: unmemoized it was the single hottest frame in a
// transcript scroll profile.
const knownZones = new Map<string, boolean>()

export function isValidIanaTimeZone(value: string): boolean {
	if (Str.trim(value).length === 0) return false

	const known = knownZones.get(value)
	if (known !== undefined) return known
	const valid = Option.isSome(
		trySync(() => new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date())),
	)
	knownZones.set(value, valid)
	return valid
}

export function getBrowserTimeZone(): string {
	const zone = Option.getOrUndefined(trySync(() => Intl.DateTimeFormat().resolvedOptions().timeZone))
	return zone && isValidIanaTimeZone(zone) ? zone : DEFAULT_TIMEZONE
}
