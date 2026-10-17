import { isSameDraft } from "@/components/settings/settings-draft"

/** Monday first, as people read a week; values are `Date#getDay` numbers (0 = Sunday). */
export const DIGEST_DAYS = [
	{ value: 1, label: "Monday" },
	{ value: 2, label: "Tuesday" },
	{ value: 3, label: "Wednesday" },
	{ value: 4, label: "Thursday" },
	{ value: 5, label: "Friday" },
	{ value: 6, label: "Saturday" },
	{ value: 0, label: "Sunday" },
] as const

export const DIGEST_HOURS = Array.from({ length: 24 }, (_, hour) => ({
	value: hour,
	label: `${String(hour).padStart(2, "0")}:00`,
}))

/** What the server applies to a subscriber who never saved a schedule. */
const DEFAULT_DIGEST_SCHEDULE = { dayOfWeek: 1, sendHour: 9, timezone: "UTC" } as const

export interface DigestPreferencesDraft {
	readonly dayOfWeek: number
	readonly sendHour: number
	readonly timezone: string
	readonly namespaces: ReadonlyArray<string>
	readonly environments: ReadonlyArray<string>
}

/**
 * The draft for someone with no subscription yet: the server's day and hour, but in the
 * browser's own zone, so the schedule reads in local time before the first save.
 */
export function newDigestDraft(browserZone: string | undefined): DigestPreferencesDraft {
	return {
		...DEFAULT_DIGEST_SCHEDULE,
		timezone:
			browserZone !== undefined && browserZone !== "" ? browserZone : DEFAULT_DIGEST_SCHEDULE.timezone,
		namespaces: [],
		environments: [],
	}
}

const sorted = (values: ReadonlyArray<string>) => [...values].sort()

/** Scopes are sets: picking the same namespaces in another order is not an edit. */
export function sameDigestDraft(a: DigestPreferencesDraft, b: DigestPreferencesDraft): boolean {
	return isSameDraft(
		{ ...a, namespaces: sorted(a.namespaces), environments: sorted(a.environments) },
		{ ...b, namespaces: sorted(b.namespaces), environments: sorted(b.environments) },
	)
}

/**
 * Zones for the picker: every zone the browser knows, plus UTC, the saved zone and the
 * browser's own zone, so the current value is always selectable even when the list lacks it.
 */
export function digestTimeZoneOptions(
	supported: ReadonlyArray<string>,
	saved: string,
	browserZone: string | undefined,
): ReadonlyArray<string> {
	const zones = new Set([...supported, "UTC", saved])
	if (browserZone) zones.add(browserZone)
	return [...zones].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)))
}
