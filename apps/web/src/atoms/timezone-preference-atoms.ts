import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"
import { getBrowserTimeZone, isValidIanaTimeZone } from "@maple/web-data/lib/timezone"

export const TIMEZONE_STORAGE_KEY = "maple.preferences.timezone"
export const SYSTEM_VALUE = "__system__"

export { getBrowserTimeZone, isValidIanaTimeZone }

export function resolveEffectiveTimezone(stored: string): string {
	if (stored === SYSTEM_VALUE) {
		return getBrowserTimeZone()
	}

	if (isValidIanaTimeZone(stored)) {
		return stored
	}

	return getBrowserTimeZone()
}

export function normalizeStoredTimezoneValue(value: string | null | undefined): string {
	if (!value || value === SYSTEM_VALUE) {
		return SYSTEM_VALUE
	}

	let decoded = value
	try {
		const parsed = JSON.parse(value) as unknown
		if (typeof parsed === "string") {
			decoded = parsed
		}
	} catch {
		// keep raw storage value
	}

	if (decoded === SYSTEM_VALUE) {
		return SYSTEM_VALUE
	}

	return isValidIanaTimeZone(decoded) ? decoded : SYSTEM_VALUE
}

export const timezonePreferenceAtom = Atom.kvs({
	runtime: localStorageRuntime,
	key: TIMEZONE_STORAGE_KEY,
	schema: Schema.String,
	defaultValue: () => SYSTEM_VALUE,
})

/**
 * The selected zone, read synchronously off storage — for code that runs
 * outside React (a preset's `getRange`, a search middleware). Components use
 * `useTimezonePreference`, which re-renders when the preference changes; this
 * is a point-in-time read of the same key the atom writes through to. Falls
 * back to the browser's zone where there is no storage to read (SSR, tests).
 */
export function getEffectiveTimezone(): string {
	try {
		return resolveEffectiveTimezone(
			normalizeStoredTimezoneValue(localStorage.getItem(TIMEZONE_STORAGE_KEY)),
		)
	} catch {
		return getBrowserTimeZone()
	}
}
