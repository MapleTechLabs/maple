const DEFAULT_TIMEZONE = "UTC"

// Whether a zone name is one the runtime knows never changes, and asking is
// not cheap — building a formatter and running it. Every timestamp the app
// prints resolves its zone through here, which on a virtualized list is once
// per row per render: unmemoized it was the single hottest frame in a
// transcript scroll profile.
const knownZones = new Map<string, boolean>()

export function isValidIanaTimeZone(value: string): boolean {
	if (value.trim().length === 0) return false

	const known = knownZones.get(value)
	if (known !== undefined) return known
	let valid: boolean
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date())
		valid = true
	} catch {
		valid = false
	}
	knownZones.set(value, valid)
	return valid
}

export function getBrowserTimeZone(): string {
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
		if (zone && isValidIanaTimeZone(zone)) {
			return zone
		}
	} catch {
		// fall through to UTC
	}

	return DEFAULT_TIMEZONE
}
