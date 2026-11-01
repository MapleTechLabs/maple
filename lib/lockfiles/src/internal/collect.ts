import type { Ecosystem, LockedPackage, Relation } from "../types.ts"

const RANK = { direct: 3, dev: 2, transitive: 1, unknown: 0 } satisfies Record<Relation, number>

const strongest = (a: Relation, b: Relation): Relation => (RANK[a] >= RANK[b] ? a : b)

/** One entry per (name, version), keeping the strongest relation, sorted for stable output. */
export const dedupePackages = (packages: ReadonlyArray<LockedPackage>): ReadonlyArray<LockedPackage> => {
	const byKey = packages.reduce((acc, pkg) => {
		const key = `${pkg.name}@${pkg.version}`
		const seen = acc.get(key)
		acc.set(key, seen === undefined ? pkg : { ...seen, relation: strongest(seen.relation, pkg.relation) })
		return acc
	}, new Map<string, LockedPackage>())
	return [...byKey.values()].sort((a, b) =>
		a.name === b.name
			? a.version < b.version
				? -1
				: a.version > b.version
					? 1
					: 0
			: a.name < b.name
				? -1
				: 1,
	)
}

export const pkg = (
	ecosystem: Ecosystem,
	name: string,
	version: string,
	relation: Relation,
): LockedPackage => ({
	ecosystem,
	name,
	version,
	relation,
})

/** Splits `name@version` (scoped names keep their leading `@`). */
export const splitNameAt = (spec: string): { readonly name: string; readonly rest: string } | undefined => {
	const at = spec.indexOf("@", 1)
	return at <= 0 ? undefined : { name: spec.slice(0, at), rest: spec.slice(at + 1) }
}

/** Registry versions start with a digit; protocols (file:, link:, git+...) and URLs do not. */
export const isRegistryVersion = (version: string): boolean => /^\d[^:/\s]*$/.test(version)

export const isRecord = (u: unknown): u is Record<string, unknown> =>
	typeof u === "object" && u !== null && !Array.isArray(u)
