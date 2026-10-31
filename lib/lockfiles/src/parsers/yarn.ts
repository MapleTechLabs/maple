import { Effect } from "effect"
import { isRecord, isRegistryVersion, pkg, splitNameAt } from "../internal/collect.ts"
import { parseYamlText } from "../internal/decode.ts"
import { readPackageJsons, type ManifestDeps } from "../internal/manifests.ts"
import type { LockedPackage, LockfileInput, Relation } from "../types.ts"
import { LockfileParseError } from "../errors.ts"
import type { ParserOutput } from "./types.ts"

interface Specifier {
	readonly name: string
	readonly range: string
}

interface Block {
	readonly specifiers: ReadonlyArray<Specifier>
	readonly version: string | undefined
}

const unquote = (s: string): string => s.trim().replace(/^"(.*)"$/, "$1")

const parseSpecifiers = (header: string): ReadonlyArray<Specifier> =>
	header
		.replace(/:\s*$/, "")
		.split(",")
		.flatMap((raw) => {
			const at = splitNameAt(unquote(raw))
			return at === undefined ? [] : [{ name: at.name, range: at.rest }]
		})

const VERSION_LINE = /^ {2}version:? +"?([^"\s]+)"?\s*$/

/** yarn v1: unindented `"a@^1", a@^1.2:` headers, each followed by an indented `version "1.2.3"`. */
const parseV1Blocks = (content: string): ReadonlyArray<Block> =>
	content.split(/\r?\n/).reduce<Array<Block>>((blocks, line) => {
		if (line === "" || line.startsWith("#")) return blocks
		if (!/^\s/.test(line)) {
			blocks.push({ specifiers: parseSpecifiers(line), version: undefined })
			return blocks
		}
		const version = VERSION_LINE.exec(line)?.[1]
		const last = blocks.at(-1)
		if (version !== undefined && last !== undefined && last.version === undefined) {
			blocks[blocks.length - 1] = { ...last, version }
		}
		return blocks
	}, [])

/** Real registry name of a specifier: `alias@npm:real@^1` names `real`; non-registry ranges have none. */
const registryName = (spec: Specifier): string | undefined => {
	if (spec.range.startsWith("npm:")) {
		const real = splitNameAt(spec.range.slice(4))
		return real === undefined ? spec.name : real.name
	}
	return /[:/]/.test(spec.range) ? undefined : spec.name
}

const requestedBy = (ranges: ManifestDeps["direct"], spec: Specifier): boolean => {
	const wanted = ranges.get(spec.name)
	return (
		wanted !== undefined &&
		(wanted.has(spec.range) || (spec.range.startsWith("npm:") && wanted.has(spec.range.slice(4))))
	)
}

const relationOf = (manifest: ManifestDeps, specs: ReadonlyArray<Specifier>): Relation =>
	!manifest.found
		? "unknown"
		: specs.some((s) => requestedBy(manifest.direct, s))
			? "direct"
			: specs.some((s) => requestedBy(manifest.dev, s))
				? "dev"
				: "transitive"

const parseYarnV1 = (blocks: ReadonlyArray<Block>, manifest: ManifestDeps) => {
	const packages = blocks.flatMap((block): ReadonlyArray<LockedPackage> => {
		const first = block.specifiers[0]
		const name = first === undefined ? undefined : registryName(first)
		if (name === undefined || block.version === undefined || !isRegistryVersion(block.version)) return []
		return [pkg("npm", name, block.version, relationOf(manifest, block.specifiers))]
	})
	return { packages, skipped: blocks.length - packages.length }
}

/** decodeURIComponent throws on stray `%`; this cannot. */
const percentDecode = (s: string): string =>
	s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

/** Berry `resolution`: `name@npm:1.0.0`, or a patch wrapping one (`name@patch:name@npm%3A1.0.0#...`). */
const berryRegistryName = (resolution: string): string | undefined => {
	const at = splitNameAt(resolution)
	if (at === undefined) return undefined
	if (at.rest.startsWith("npm:")) return at.name
	if (!at.rest.startsWith("patch:")) return undefined
	const inner = at.rest.slice("patch:".length).split("#")[0] ?? ""
	return berryRegistryName(percentDecode(inner))
}

const parseYarnBerry = (doc: Record<string, unknown>, manifest: ManifestDeps) => {
	const entries = Object.entries(doc).filter(([key]) => key !== "__metadata")
	const packages = entries.flatMap(([key, value]): ReadonlyArray<LockedPackage> => {
		if (!isRecord(value) || typeof value.resolution !== "string") return []
		const name = berryRegistryName(value.resolution)
		const version = typeof value.version === "string" ? value.version : ""
		if (name === undefined || !isRegistryVersion(version)) return []
		return [pkg("npm", name, version, relationOf(manifest, parseSpecifiers(key)))]
	})
	const workspaces = entries.filter(([key]) => key.includes("@workspace:")).length
	return { packages, skipped: entries.length - packages.length - workspaces }
}

const berryResult = Effect.fn(function* (input: LockfileInput, manifest: ManifestDeps) {
	const doc = yield* parseYamlText(input.path, input.content)
	if (!isRecord(doc))
		return yield* new LockfileParseError({ path: input.path, message: "yarn.lock is not a YAML mapping" })
	return parseYarnBerry(doc, manifest)
})

const v1Result = Effect.fn(function* (input: LockfileInput, manifest: ManifestDeps) {
	const blocks = parseV1Blocks(input.content)
	const broken = blocks.find((b) => b.specifiers.length === 0 || b.version === undefined)
	if (broken !== undefined) {
		return yield* new LockfileParseError({
			path: input.path,
			message: "yarn.lock has an entry without specifiers or version",
		})
	}
	return parseYarnV1(blocks, manifest)
})

const isBerry = (content: string): boolean => /^__metadata:/m.test(content)

export const parseYarnLock = Effect.fn("lockfiles.parseYarnLock")(function* (input: LockfileInput) {
	const manifest = yield* readPackageJsons(input.manifests)
	const berry = isBerry(input.content)
	const result = berry ? yield* berryResult(input, manifest) : yield* v1Result(input, manifest)
	const warnings = [
		...manifest.warnings,
		...(manifest.found ? [] : ["no package.json provided: relations are unknown"]),
		...(result.skipped > 0
			? [`skipped ${result.skipped} non-registry packages (git, tarball or local)`]
			: []),
	]
	const output: ParserOutput = {
		kind: berry ? "yarn-berry" : "yarn-v1",
		packages: result.packages,
		warnings,
	}
	return output
})
