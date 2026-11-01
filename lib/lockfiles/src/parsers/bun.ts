import { Effect, Schema } from "effect"
import { isRegistryVersion, pkg, splitNameAt } from "../internal/collect.ts"
import { decodeJson, stripTrailingCommas } from "../internal/decode.ts"
import type { LockedPackage, LockfileInput, Relation } from "../types.ts"
import type { ParserOutput } from "./types.ts"

const Deps = Schema.optionalKey(Schema.Record(Schema.String, Schema.String))

const Workspace = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	dependencies: Deps,
	devDependencies: Deps,
	optionalDependencies: Deps,
	peerDependencies: Deps,
})
type Workspace = typeof Workspace.Type

const BunLock = Schema.Struct({
	lockfileVersion: Schema.Finite,
	workspaces: Schema.optionalKey(Schema.Record(Schema.String, Workspace)),
	packages: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.Unknown))),
})

/** Package keys are install paths of dependency names (`express/debug`, `@fx/a/lodash`); split them. */
const keySegments = (key: string): ReadonlyArray<string> =>
	key.split("/").reduce<Array<string>>((segments, part) => {
		const last = segments.at(-1)
		if (last !== undefined && last.startsWith("@") && !last.includes("/"))
			segments[segments.length - 1] = `${last}/${part}`
		else segments.push(part)
		return segments
	}, [])

interface DepNames {
	readonly direct: ReadonlySet<string>
	readonly dev: ReadonlySet<string>
}

const namesOf = (workspaces: ReadonlyArray<Workspace>): DepNames => ({
	direct: new Set(
		workspaces.flatMap((w) => [
			...Object.keys(w.dependencies ?? {}),
			...Object.keys(w.optionalDependencies ?? {}),
			...Object.keys(w.peerDependencies ?? {}),
		]),
	),
	dev: new Set(workspaces.flatMap((w) => Object.keys(w.devDependencies ?? {}))),
})

export const parseBunLock = Effect.fn("lockfiles.parseBunLock")(function* (input: LockfileInput) {
	const lock = yield* decodeJson(BunLock, input.path, stripTrailingCommas(input.content))
	const workspaces = Object.values(lock.workspaces ?? {})
	const all = namesOf(workspaces)
	const byWorkspaceName = new Map(
		workspaces.flatMap((w): ReadonlyArray<readonly [string, DepNames]> =>
			w.name === undefined ? [] : [[w.name, namesOf([w])]],
		),
	)
	const entries = Object.entries(lock.packages ?? {}).map(([key, entry]) => ({
		key,
		spec: typeof entry[0] === "string" ? splitNameAt(entry[0]) : undefined,
	}))
	const skipped = entries.filter(
		({ spec }) =>
			spec === undefined || !(isRegistryVersion(spec.rest) || spec.rest.startsWith("workspace:")),
	).length
	const packages = entries.flatMap(({ key, spec }): ReadonlyArray<LockedPackage> => {
		if (spec === undefined || !isRegistryVersion(spec.rest)) return []
		const segments = keySegments(key)
		const parent = segments.slice(0, -1).join("/")
		const depName = segments.at(-1) ?? ""
		const scope = parent === "" ? all : byWorkspaceName.get(parent)
		const relation: Relation =
			scope?.direct.has(depName) === true
				? "direct"
				: scope?.dev.has(depName) === true
					? "dev"
					: "transitive"
		return [pkg("npm", spec.name, spec.rest, relation)]
	})
	const warnings = skipped > 0 ? [`skipped ${skipped} non-registry packages (git, tarball or local)`] : []
	const output: ParserOutput = { kind: "bun-lock", packages, warnings }
	return output
})
