const hasKey = <T extends object>(table: T, key: PropertyKey): key is keyof T => Object.hasOwn(table, key)

/** Reads a fixed table by an arbitrary string; only own keys match, never `constructor` and friends. */
export function lookup<T extends object>(table: T, key: string): T[keyof T] | undefined {
	return hasKey(table, key) ? table[key] : undefined
}
