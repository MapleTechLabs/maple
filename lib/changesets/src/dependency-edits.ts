/** Which internal dependency ranges `changeset version` rewrites, and to what. */
import { type DependencyUpdateOptions, shouldUpdateDependency, type VersionedRelease } from "./changelog.ts"
import type { JsonEdit } from "./json-edit.ts"
import {
	increment,
	isAnyRange,
	isPrerelease,
	isValidRange,
	rangeComparators,
	satisfies,
	type BumpType,
} from "./semver.ts"
import { DEPENDENCY_TYPES, type PackageJson } from "./types.ts"

export interface EditOptions extends DependencyUpdateOptions {
	readonly bumpVersionsWithWorkspaceProtocolOnly: boolean
}

const rangeType = (range: string) => {
	if (range.startsWith("^")) return "^"
	if (range.startsWith("~")) return "~"
	if (range.startsWith(">=")) return ">="
	if (range.startsWith("<=")) return "<="
	if (range.startsWith(">")) return ">"
	return ""
}

/** `getNewDependencyRange`: keep the range's operator, or move both bounds of `>=a <b`. */
export const newDependencyRange = (range: string, newVersion: string, type: BumpType): string => {
	const sets = rangeComparators(range)
	const comparators = sets.length === 1 ? (sets[0] ?? []) : []
	if (comparators.length === 2 && range.includes(">") && range.includes("<")) {
		const lower = comparators.find(({ operator }) => operator.startsWith(">"))
		const upper = comparators.find(({ operator }) => operator.startsWith("<"))
		if (lower !== undefined && upper !== undefined) {
			const newUpper = satisfies(newVersion, upper.value)
				? upper.value
				: `<${increment(newVersion, type)}`
			return comparators[0] === lower ? `>=${newVersion} ${newUpper}` : `${newUpper} >=${newVersion}`
		}
	}
	return `${rangeType(range)}${newVersion}`
}

/** `getDependencyVersionEdits` for one manifest against every release in the plan. */
export const dependencyEdits = (
	packageJson: PackageJson,
	releases: ReadonlyArray<VersionedRelease>,
	options: EditOptions,
): ReadonlyArray<JsonEdit> =>
	DEPENDENCY_TYPES.flatMap((depType) => {
		const deps = packageJson[depType]
		if (deps === undefined) return []
		return releases.flatMap((release): ReadonlyArray<JsonEdit> => {
			const { name, newVersion, type } = release
			if (newVersion === undefined || type === "none") return []
			const current = deps[name]
			if (
				!current ||
				current.startsWith("file:") ||
				current.startsWith("link:") ||
				!shouldUpdateDependency(release, current, depType, options)
			) {
				return []
			}
			const workspace = current.startsWith("workspace:")
			if (!workspace && (options.bumpVersionsWithWorkspaceProtocolOnly || !isValidRange(current)))
				return []
			const range = workspace ? current.slice("workspace:".length) : current
			if (workspace && (range === "*" || range === "^" || range === "~" || !isValidRange(range)))
				return []
			if (isAnyRange(range) && !isPrerelease(newVersion)) return []
			const next = newDependencyRange(range, newVersion, type)
			return [{ keys: [depType, name], value: workspace ? `workspace:${next}` : next }]
		})
	})
