import { Effect, Schema, Array as Arr, String as Str } from "effect"
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

/** crates.io, through either index; an alternate registry's crate is not the crates.io one of that name. */
const CRATES_IO_SOURCES: ReadonlySet<string> = new Set([
	"registry+https://github.com/rust-lang/crates.io-index",
	"sparse+https://index.crates.io/",
])

/** Member dependency entries: `name`, `name version` or `name version (source)`. */
const parseDependency = (entry: string): { readonly name: string; readonly version: string | undefined } => {
	const [name, version] = Str.split(/\s+/)(Str.trim(entry))
	return { name, version }
}

export const parseCargoLock = Effect.fn("lockfiles.parseCargoLock")(function* (input: LockfileInput) {
	const toml = yield* parseTomlText(input.path, input.content)
	const lock = yield* decodeUnknown(CargoLock, input.path, toml)
	const all = lock.package ?? []
	const members = Arr.filter(all, (p) => p.source === undefined)
	const directDeps = Arr.flatMap(members, (m) => Arr.map(m.dependencies ?? [], parseDependency))
	const direct = new Set(
		Arr.map(directDeps, (d) => (d.version === undefined ? d.name : `${d.name}@${d.version}`)),
	)
	const isDirect = (name: string, version: string): boolean =>
		direct.has(name) || direct.has(`${name}@${version}`)
	const packages = Arr.flatMap(all, (p): ReadonlyArray<LockedPackage> =>
		p.source !== undefined && CRATES_IO_SOURCES.has(p.source)
			? [pkg("crates.io", p.name, p.version, isDirect(p.name, p.version) ? "direct" : "transitive")]
			: [],
	)
	const skipped = all.length - members.length - packages.length
	const warnings = skipped > 0 ? [`skipped ${skipped} git, path or alternate-registry packages`] : []
	const output: ParserOutput = { kind: "cargo-lock", packages, warnings }
	return output
})
