import { Effect, Schema } from "effect"
import { pkg } from "../internal/collect.ts"
import { decodeUnknown, parseTomlText } from "../internal/decode.ts"
import type { LockedPackage, LockfileInput } from "../types.ts"
import type { ParserOutput } from "./types.ts"

const CargoPackage = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	source: Schema.optionalKey(Schema.String),
	dependencies: Schema.optionalKey(Schema.Array(Schema.String)),
})

const CargoLock = Schema.Struct({
	package: Schema.optionalKey(Schema.Array(CargoPackage)),
})

/** Registry sources: `registry+<index url>` or `sparse+<index url>`; git and path sources are not. */
const isRegistrySource = (source: string | undefined): boolean =>
	source !== undefined && (source.startsWith("registry+") || source.startsWith("sparse+"))

/** Member dependency entries: `name`, `name version` or `name version (source)`. */
const parseDependency = (entry: string): { readonly name: string; readonly version: string | undefined } => {
	const [name = "", version] = entry.trim().split(/\s+/)
	return { name, version }
}

export const parseCargoLock = Effect.fn("lockfiles.parseCargoLock")(function* (input: LockfileInput) {
	const lock = yield* decodeUnknown(CargoLock, input.path, yield* parseTomlText(input.path, input.content))
	const all = lock.package ?? []
	const members = all.filter((p) => p.source === undefined)
	const directDeps = members.flatMap((m) => (m.dependencies ?? []).map(parseDependency))
	const direct = new Set(
		directDeps.map((d) => (d.version === undefined ? d.name : `${d.name}@${d.version}`)),
	)
	const isDirect = (name: string, version: string): boolean =>
		direct.has(name) || direct.has(`${name}@${version}`)
	const packages = all.flatMap((p): ReadonlyArray<LockedPackage> =>
		isRegistrySource(p.source)
			? [pkg("crates.io", p.name, p.version, isDirect(p.name, p.version) ? "direct" : "transitive")]
			: [],
	)
	const skipped = all.length - members.length - packages.length
	const warnings = skipped > 0 ? [`skipped ${skipped} git or path packages`] : []
	const output: ParserOutput = { kind: "cargo-lock", packages, warnings }
	return output
})
