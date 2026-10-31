import { Effect } from "effect"
import { isRecord, isRegistryVersion, pkg, splitNameAt } from "../internal/collect.ts"
import { parseYamlText } from "../internal/decode.ts"
import { LockfileParseError } from "../errors.ts"
import type { LockedPackage, LockfileInput, Relation } from "../types.ts"
import type { ParserOutput } from "./types.ts"

interface NameVersion {
	readonly name: string
	readonly version: string
}

/** Drops peer suffixes: v6+ `(react@18.2.0)` groups, v5 `_react@18.2.0` tails. */
const stripPeers = (version: string): string => version.replace(/\(.*$/, "").replace(/_.*$/, "")

const V5_KEY = /^((?:@[^/]+\/)?[^/@]+)\/(\d[^/]*)$/

/** Package keys: v5 `/name/1.0.0`, v6 `/name@1.0.0`, v9 `name@1.0.0`, optionally registry-prefixed. */
const parsePnpmKey = (key: string): NameVersion | undefined => {
	const bare = key
		.replace(/\(.*$/, "")
		.replace(/^[^/@]*\.[^/@]*\//, "")
		.replace(/^\//, "")
	const v5 = V5_KEY.exec(bare)
	if (v5 !== null) {
		const version = stripPeers(v5[2] ?? "")
		return isRegistryVersion(version) ? { name: v5[1] ?? "", version } : undefined
	}
	const at = splitNameAt(bare)
	return at !== undefined && isRegistryVersion(at.rest) ? { name: at.name, version: at.rest } : undefined
}

/** Importer dependency values: v5 a version string, v6+ `{ specifier, version }`; aliases are keys. */
const importerVersion = (name: string, value: unknown): NameVersion | undefined => {
	const raw =
		typeof value === "string"
			? value
			: isRecord(value) && typeof value.version === "string"
				? value.version
				: ""
	if (isRegistryVersion(stripPeers(raw))) return { name, version: stripPeers(raw) }
	return parsePnpmKey(raw)
}

const importerKeys = (importer: unknown, fields: ReadonlyArray<string>): ReadonlyArray<string> =>
	isRecord(importer)
		? fields.flatMap((field) => {
				const deps = importer[field]
				return isRecord(deps)
					? Object.entries(deps).flatMap(([name, value]) => {
							const nv = importerVersion(name, value)
							return nv === undefined ? [] : [`${nv.name}@${nv.version}`]
						})
					: []
			})
		: []

const PROD_FIELDS = ["dependencies", "optionalDependencies"]

const entryNameVersion = (key: string, value: unknown): NameVersion | undefined => {
	const fromKey = parsePnpmKey(key)
	if (fromKey !== undefined) return fromKey
	// Tarball and git keys carry the registry identity in explicit name/version fields, when they have one.
	return isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.version === "string" &&
		isRegistryVersion(value.version)
		? { name: value.name, version: value.version }
		: undefined
}

export const parsePnpmLock = Effect.fn("lockfiles.parsePnpmLock")(function* (input: LockfileInput) {
	const doc = yield* parseYamlText(input.path, input.content)
	if (!isRecord(doc) || doc.lockfileVersion === undefined) {
		return yield* new LockfileParseError({
			path: input.path,
			message: "pnpm-lock.yaml has no lockfileVersion",
		})
	}
	const importers = isRecord(doc.importers) ? Object.values(doc.importers) : [doc]
	const direct = new Set(importers.flatMap((importer) => importerKeys(importer, PROD_FIELDS)))
	const dev = new Set(importers.flatMap((importer) => importerKeys(importer, ["devDependencies"])))
	const entries = [
		...(isRecord(doc.packages) ? Object.entries(doc.packages) : []),
		...(isRecord(doc.snapshots) ? Object.entries(doc.snapshots) : []),
	]
	const skipped = new Set<string>()
	const packages = entries.flatMap(([key, value]): ReadonlyArray<LockedPackage> => {
		const nv = entryNameVersion(key, value)
		if (nv === undefined) {
			skipped.add(key)
			return []
		}
		const id = `${nv.name}@${nv.version}`
		const devFlag = isRecord(value) && value.dev === true
		const relation: Relation = direct.has(id) ? "direct" : dev.has(id) || devFlag ? "dev" : "transitive"
		return [pkg("npm", nv.name, nv.version, relation)]
	})
	const warnings =
		skipped.size > 0 ? [`skipped ${skipped.size} non-registry packages (git, tarball or local)`] : []
	const output: ParserOutput = { kind: "pnpm-lock", packages, warnings }
	return output
})
