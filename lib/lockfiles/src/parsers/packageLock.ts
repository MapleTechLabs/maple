import { Effect, Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { isRecord, isRegistryVersion, pkg, splitNameAt } from "../internal/collect.ts"
import { decodeJson } from "../internal/decode.ts"
import { readPackageJsons } from "../internal/manifests.ts"
import type { LockedPackage, LockfileInput, Relation } from "../types.ts"
import type { ParserOutput } from "./types.ts"

const Deps = Schema.optionalKey(Schema.Record(Schema.String, Schema.String))

const PackageEntry = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	version: Schema.optionalKey(Schema.String),
	dev: Schema.optionalKey(Schema.Boolean),
	devOptional: Schema.optionalKey(Schema.Boolean),
	link: Schema.optionalKey(Schema.Boolean),
	dependencies: Deps,
	optionalDependencies: Deps,
	peerDependencies: Deps,
	devDependencies: Deps,
})
type PackageEntry = typeof PackageEntry.Type

const PackageLock = Schema.Struct({
	lockfileVersion: Schema.optionalKey(Schema.Finite),
	packages: Schema.optionalKey(Schema.Record(Schema.String, PackageEntry)),
	dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

const NODE_MODULES = "node_modules/"

/** v2/v3: `packages` keyed by install path; roots are "" and workspace dirs (no node_modules segment). */
const fromPackagesMap = (packages: Readonly<Record<string, PackageEntry>>): ReadonlyArray<LockedPackage> => {
	const rootDeps = new Map(
		Arr.map(
			Arr.filter(Rec.toEntries(packages), ([path]) => !Str.includes(NODE_MODULES)(path)),
			([path, entry]) => [
				path,
				new Set([
					...Rec.keys(entry.dependencies ?? {}),
					...Rec.keys(entry.optionalDependencies ?? {}),
					...Rec.keys(entry.peerDependencies ?? {}),
				]),
			],
		),
	)
	// Workspaces hoist their dependencies into the root node_modules, so the root answers for all of them.
	const hoisted = new Set(Arr.flatMap([...rootDeps.values()], (names) => [...names]))
	return Arr.flatMap(Rec.toEntries(packages), ([path, entry]) => {
		const found = Str.lastIndexOf(NODE_MODULES)(path)
		if (Option.isNone(found) || entry.link === true || entry.version === undefined) return []
		const at = found.value
		const installName = Str.slice(at + NODE_MODULES.length)(path)
		const name = entry.name ?? installName
		if (!isRegistryVersion(entry.version)) return []
		const parent = Str.slice(0, Math.max(at - 1, 0))(path)
		const isDirect = (parent === "" ? hoisted : rootDeps.get(parent))?.has(installName) === true
		const relation: Relation = isDirect
			? "direct"
			: entry.dev === true || entry.devOptional === true
				? "dev"
				: "transitive"
		return [pkg("npm", name, entry.version, relation)]
	})
}

/** v1: nested `dependencies` tree; top-level only tells direct apart with the manifest. */
const fromDependencyTree = (
	deps: Readonly<Record<string, unknown>>,
	directNames: ReadonlySet<string> | undefined,
	topLevel: boolean,
): ReadonlyArray<LockedPackage> =>
	Arr.flatMap(Rec.toEntries(deps), ([name, node]): ReadonlyArray<LockedPackage> => {
		if (!isRecord(node)) return []
		const recorded = typeof node.version === "string" ? node.version : ""
		const nested = isRecord(node.dependencies)
			? fromDependencyTree(node.dependencies, directNames, false)
			: []
		// An `npm:` alias records the real package as `version: "npm:real@1.0.0"`.
		const alias = Str.startsWith("npm:")(recorded)
			? splitNameAt(Str.slice("npm:".length)(recorded))
			: undefined
		const realName = alias?.name ?? name
		const version = alias?.rest ?? recorded
		if (!isRegistryVersion(version)) return nested
		const relation: Relation =
			topLevel && directNames?.has(name) === true
				? "direct"
				: node.dev === true
					? "dev"
					: directNames === undefined
						? "unknown"
						: "transitive"
		return [pkg("npm", realName, version, relation), ...nested]
	})

export const parsePackageLock = Effect.fn("lockfiles.parsePackageLock")(function* (input: LockfileInput) {
	const lock = yield* decodeJson(PackageLock, input.path, input.content)
	if (lock.packages !== undefined && Rec.keys(lock.packages).length > 0) {
		const output: ParserOutput = {
			kind: "package-lock",
			packages: fromPackagesMap(lock.packages),
			warnings: [],
		}
		return output
	}
	const manifest = yield* readPackageJsons(input.manifests)
	const directNames = manifest.found ? new Set(manifest.direct.keys()) : undefined
	const warnings = manifest.found
		? manifest.warnings
		: [...manifest.warnings, "lockfileVersion 1 without package.json: direct dependencies are unknown"]
	const output: ParserOutput = {
		kind: "package-lock",
		packages: fromDependencyTree(lock.dependencies ?? {}, directNames, true),
		warnings,
	}
	return output
})
