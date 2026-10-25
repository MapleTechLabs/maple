// Memory-only mode: nothing the SDK keeps (session, visitor, consent revoke,
// replay or offline buffers) touches cookies, Web Storage or IndexedDB. On
// `globalThis` like consent, so both SDK copies on a page agree, and it only
// ever tightens: a second init without the option must not re-enable storage.
const MEMORY_ONLY_KEY = "__MAPLE_BROWSER_MEMORY_ONLY__"

export type Persistence = "browser" | "memory"

export function configurePersistence(persistence: Persistence | undefined): void {
	if (persistence === "memory") (globalThis as Record<string, unknown>)[MEMORY_ONLY_KEY] = true
}

/** Whether the SDK may write anything to the device. */
export function mayUseStorage(): boolean {
	return (globalThis as Record<string, unknown>)[MEMORY_ONLY_KEY] !== true
}

/** Test seam. */
export function resetPersistenceForTests(): void {
	delete (globalThis as Record<string, unknown>)[MEMORY_ONLY_KEY]
}
