import { Effect, Schema } from "effect"
import { decodeJson } from "./decode.ts"

const Deps = Schema.optionalKey(Schema.Record(Schema.String, Schema.String))

const PackageJson = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	dependencies: Deps,
	devDependencies: Deps,
	optionalDependencies: Deps,
	peerDependencies: Deps,
})

/** Dependency name to the ranges manifests request it with. */
export type RangesByName = ReadonlyMap<string, ReadonlySet<string>>

export interface ManifestDeps {
	readonly direct: RangesByName
	readonly dev: RangesByName
	/** Names of the workspace packages themselves. */
	readonly local: ReadonlySet<string>
	readonly warnings: ReadonlyArray<string>
	readonly found: boolean
}

const addRanges = (target: Map<string, Set<string>>, deps: Readonly<Record<string, string>> | undefined) =>
	Object.entries(deps ?? {}).forEach(([name, range]) => {
		const ranges = target.get(name) ?? new Set<string>()
		ranges.add(range)
		target.set(name, ranges)
	})

/** Reads every `package.json` among the manifests; an undecodable one becomes a warning. */
export const readPackageJsons = Effect.fn("lockfiles.readPackageJsons")(function* (
	manifests: ReadonlyMap<string, string> | undefined,
) {
	const entries = [...(manifests ?? new Map<string, string>())].filter(
		([path]) => path === "package.json" || path.endsWith("/package.json"),
	)
	const decoded = yield* Effect.forEach(entries, ([path, content]) =>
		decodeJson(PackageJson, path, content).pipe(Effect.result),
	)
	const direct = new Map<string, Set<string>>()
	const dev = new Map<string, Set<string>>()
	const local = new Set<string>()
	const warnings = decoded.flatMap((result) => {
		if (result._tag === "Failure")
			return [`skipped manifest ${result.failure.path}: ${result.failure.message}`]
		const manifest = result.success
		if (manifest.name !== undefined) local.add(manifest.name)
		addRanges(direct, manifest.dependencies)
		addRanges(direct, manifest.optionalDependencies)
		addRanges(direct, manifest.peerDependencies)
		addRanges(dev, manifest.devDependencies)
		return []
	})
	const result: ManifestDeps = { direct, dev, local, warnings, found: entries.length > 0 }
	return result
})
