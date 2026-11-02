/**
 * The handful of node-semver operations changesets relies on, over `effect/SemVer` and
 * `effect/SemVerRange`. `rangeComparators` re-implements node-semver's desugaring for the two
 * places where changesets reads a range's structure instead of only matching against it.
 */
import { Result, SemVer, SemVerRange } from "effect"

export type BumpType = "major" | "minor" | "patch"

const parseVersion = (version: string | undefined) =>
	version === undefined ? Result.failVoid : Result.mapError(SemVer.parse(version.trim()), () => undefined)

export const isValidRange = (range: string): boolean => Result.isSuccess(SemVerRange.parse(range.trim()))

/** `semver.satisfies`: an invalid version or range never satisfies. */
export const satisfies = (version: string | undefined, range: string | undefined): boolean => {
	if (range === undefined) return false
	const parsedVersion = parseVersion(version)
	const parsedRange = SemVerRange.parse(range.trim())
	return (
		Result.isSuccess(parsedVersion) &&
		Result.isSuccess(parsedRange) &&
		SemVerRange.matches(parsedRange.success, parsedVersion.success)
	)
}

const bumps = { major: SemVer.bumpMajor, minor: SemVer.bumpMinor, patch: SemVer.bumpPatch } as const

/** `semver.inc` for the three release types; `undefined` for an invalid version, like `null` there. */
export const increment = (version: string | undefined, type: BumpType): string | undefined => {
	const parsed = parseVersion(version)
	return Result.isSuccess(parsed) ? SemVer.format(bumps[type](parsed.success)) : undefined
}

export const isPrerelease = (version: string): boolean => {
	const parsed = parseVersion(version)
	return Result.isSuccess(parsed) && SemVer.isPrerelease(parsed.success)
}

export const greaterThan = (a: string, b: string): boolean => {
	const left = parseVersion(a)
	const right = parseVersion(b)
	return (
		Result.isSuccess(left) && Result.isSuccess(right) && SemVer.isGreaterThan(left.success, right.success)
	)
}

export const lessThan = (a: string, b: string): boolean => {
	const left = parseVersion(a)
	const right = parseVersion(b)
	return Result.isSuccess(left) && Result.isSuccess(right) && SemVer.isLessThan(left.success, right.success)
}

export interface Comparator {
	readonly operator: string
	readonly value: string
}

const isX = (part: string | undefined) => part === undefined || part === "x" || part === "X" || part === "*"
const partialPattern =
	/^v?(\d+|[xX*])?(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const operatorPattern = /^(<=|>=|<|>|=|~>|~|\^)?(.*)$/

// node-semver's expansion of one comparator token; an empty list is "any version".
const desugarToken = (operator: string, version: string): ReadonlyArray<Comparator> => {
	const match = partialPattern.exec(version)
	if (match === null) return [{ operator, value: version }]
	const [, major, minor, patch, pre] = match
	if (isX(major)) return operator === "<" || operator === ">" ? [{ operator: "<", value: "<0.0.0-0" }] : []
	const M = Number(major)
	const m = Number(minor)
	const full = `${major}.${minor}.${patch}${pre === undefined ? "" : `-${pre}`}`
	switch (operator) {
		case ">":
			return isX(minor)
				? [{ operator: ">=", value: `>=${M + 1}.0.0` }]
				: isX(patch)
					? [{ operator: ">=", value: `>=${M}.${m + 1}.0` }]
					: [{ operator: ">", value: `>${full}` }]
		case ">=": {
			const value = isX(minor) ? `>=${M}.0.0` : isX(patch) ? `>=${M}.${m}.0` : `>=${full}`
			return value === ">=0.0.0" ? [] : [{ operator: ">=", value }]
		}
		case "<":
			return [
				{
					operator: "<",
					value: isX(minor) ? `<${M}.0.0-0` : isX(patch) ? `<${M}.${m}.0-0` : `<${full}`,
				},
			]
		case "<=":
			return isX(minor)
				? [{ operator: "<", value: `<${M + 1}.0.0-0` }]
				: isX(patch)
					? [{ operator: "<", value: `<${M}.${m + 1}.0-0` }]
					: [{ operator: "<=", value: `<=${full}` }]
		case "":
		case "=":
			return isX(minor) || isX(patch)
				? [
						{ operator: ">=", value: ">=" },
						{ operator: "<", value: "<" },
					]
				: [{ operator: "", value: full }]
		default:
			// Caret and tilde always expand to a lower and an upper bound.
			return [
				{ operator: ">=", value: ">=" },
				{ operator: "<", value: "<" },
			]
	}
}

const tokens = (set: string): ReadonlyArray<string> => {
	const parts = set
		.trim()
		.split(/\s+/)
		.filter((part) => part.length > 0)
	return parts.reduce<Array<string>>((merged, part) => {
		const previous = merged.at(-1)
		return previous !== undefined && /^(<=|>=|<|>|=|~>|~|\^)$/.test(previous)
			? [...merged.slice(0, -1), `${previous}${part}`]
			: [...merged, part]
	}, [])
}

/** The comparators node-semver builds for one `||`-free comparator set. */
export const setComparators = (set: string): ReadonlyArray<Comparator> => {
	const parts = tokens(set)
	if (parts.length === 3 && parts[1] === "-") {
		return isX(partialPattern.exec(parts[0])?.[1]) && isX(partialPattern.exec(parts[2])?.[1])
			? []
			: [
					{ operator: ">=", value: ">=" },
					{ operator: "<=", value: "<=" },
				]
	}
	return parts.flatMap((part) => {
		const [, operator = "", version = ""] = operatorPattern.exec(part) ?? []
		return desugarToken(operator, version)
	})
}

/** `new Range(range).range === ""`: some alternative accepts every version. */
export const isAnyRange = (range: string): boolean =>
	range.split("||").some((set) => setComparators(set).length === 0)

/** `new Range(range).set`: one comparator list per `||` alternative. */
export const rangeComparators = (range: string): ReadonlyArray<ReadonlyArray<Comparator>> =>
	range.split("||").map(setComparators)
