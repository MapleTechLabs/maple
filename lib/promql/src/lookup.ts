/** Own-key lookup in a constant table; prototype keys like `constructor` are absent. */
export const lookup = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
	Object.hasOwn(table, key) ? table[key] : undefined
