// Memory-only mode: nothing the SDK keeps (session, visitor, consent revoke,
// replay or offline buffers) touches cookies, Web Storage or IndexedDB. On
// `globalThis` like consent, so both SDK copies on a page agree, and it only
// ever tightens: a second init without the option must not re-enable storage.
const MEMORY_ONLY_KEY = "__MAPLE_BROWSER_MEMORY_ONLY__"
// Cookieless also sets MEMORY_ONLY_KEY, so an older SDK copy on the page stores
// nothing either. An explicit `"memory"` is the stricter choice and wins.
const COOKIELESS_KEY = "__MAPLE_BROWSER_COOKIELESS__"
const STRICT_MEMORY_KEY = "__MAPLE_BROWSER_STRICT_MEMORY__"

export type Persistence = "browser" | "memory" | "cookieless"

export function configurePersistence(persistence: Persistence | undefined): void {
	const owner = globalThis as Record<string, unknown>
	if (persistence === "memory") {
		owner[MEMORY_ONLY_KEY] = true
		owner[STRICT_MEMORY_KEY] = true
	} else if (persistence === "cookieless") {
		owner[MEMORY_ONLY_KEY] = true
		owner[COOKIELESS_KEY] = true
	}
}

/** Whether the SDK may write anything to the device. */
export function mayUseStorage(): boolean {
	return (globalThis as Record<string, unknown>)[MEMORY_ONLY_KEY] !== true
}

/** Cookieless mode is on and no SDK copy asked for the stricter `"memory"`. */
export function isCookieless(): boolean {
	const owner = globalThis as Record<string, unknown>
	return owner[COOKIELESS_KEY] === true && owner[STRICT_MEMORY_KEY] !== true
}

/** Test seam. */
export function resetPersistenceForTests(): void {
	const owner = globalThis as Record<string, unknown>
	delete owner[MEMORY_ONLY_KEY]
	delete owner[COOKIELESS_KEY]
	delete owner[STRICT_MEMORY_KEY]
}
