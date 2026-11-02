/**
 * `@changesets/assemble-release-plan` outside pre mode and snapshots: flatten changesets into
 * releases, then bump dependents and apply fixed/linked groups until nothing changes.
 * Release order is insertion order, which decides changelog and status output order.
 */
import { Result } from "effect"
import { type Config, shouldSkipPackage, skipOptions } from "./config.ts"
import { dependentsGraph, workspacePathMatches } from "./dependents.ts"
import { greaterThan, increment, isValidRange, satisfies } from "./semver.ts"
import {
	type ComprehensiveRelease,
	DEPENDENCY_TYPES,
	type DependencyType,
	type NewChangeset,
	type Package,
	type Packages,
	type ReleasePlan,
	type VersionType,
} from "./types.ts"

interface MutableRelease {
	readonly name: string
	type: VersionType
	oldVersion: string | undefined
	readonly changesets: Array<string>
}

const rank = { major: 3, minor: 2, patch: 1, none: 0 } as const satisfies Record<VersionType, number>

const newVersionOf = (release: MutableRelease) =>
	release.type === "none" ? release.oldVersion : increment(release.oldVersion, release.type)

const highestType = (releases: ReadonlyArray<MutableRelease>): VersionType =>
	releases.reduce<VersionType>(
		(highest, release) => (rank[release.type] > rank[highest] ? release.type : highest),
		"none",
	)

const highestVersion = (group: ReadonlyArray<string>, byName: ReadonlyMap<string, Package>) =>
	group.reduce<string | undefined>((highest, name) => {
		const version = byName.get(name)?.packageJson.version
		return version !== undefined && (highest === undefined || greaterThan(version, highest))
			? version
			: highest
	}, undefined)

const flattenReleases = (
	changesets: ReadonlyArray<NewChangeset>,
	byName: ReadonlyMap<string, Package>,
	config: Config,
) =>
	changesets.reduce((releases, changeset) => {
		changeset.releases.forEach(({ name, type }) => {
			const pkg = byName.get(name)
			if (pkg === undefined || shouldSkipPackage(pkg, skipOptions(config))) return
			const release = releases.get(name)
			if (release === undefined) {
				releases.set(name, {
					name,
					type,
					oldVersion: pkg.packageJson.version,
					changesets: [changeset.id],
				})
				return
			}
			if (rank[type] > rank[release.type]) release.type = type
			release.changesets.push(changeset.id)
		})
		return releases
	}, new Map<string, MutableRelease>())

interface DependencyRange {
	readonly depType: DependencyType
	// `undefined` when the dependency has no version: it then satisfies nothing.
	readonly versionRange: string | undefined
}

const dependencyRanges = (
	rootDir: string,
	dependent: Package,
	release: MutableRelease,
	dependency: Package,
) =>
	DEPENDENCY_TYPES.flatMap((depType): ReadonlyArray<DependencyRange> => {
		const raw = dependent.packageJson[depType]?.[release.name]
		if (!raw) return []
		if (!raw.startsWith("workspace:")) return [{ depType, versionRange: raw }]
		const range = raw.slice("workspace:".length)
		if (range === "*") return [{ depType, versionRange: release.oldVersion }]
		if (range === "^" || range === "~")
			return [{ depType, versionRange: `${range}${release.oldVersion}` }]
		if (isValidRange(range)) return [{ depType, versionRange: range }]
		return workspacePathMatches(range, rootDir, dependency)
			? [{ depType, versionRange: release.oldVersion }]
			: []
	})

interface Context {
	readonly releases: Map<string, MutableRelease>
	readonly byName: ReadonlyMap<string, Package>
	readonly rootDir: string
	readonly graph: ReadonlyMap<string, ReadonlyArray<string>>
	readonly config: Config
}

const dependentType = (
	ctx: Context,
	dependentPkg: Package,
	next: MutableRelease,
): VersionType | undefined => {
	if (shouldSkipPackage(dependentPkg, skipOptions(ctx.config))) return "none"
	const dependency = ctx.byName.get(next.name)
	if (dependency === undefined || next.type === "none") return undefined
	const existing = ctx.releases.get(dependentPkg.packageJson.name)
	return dependencyRanges(ctx.rootDir, dependentPkg, next, dependency).reduce<VersionType | undefined>(
		(type, { depType, versionRange }) => {
			const needsBump =
				(existing === undefined || existing.type === "none") &&
				(ctx.config.updateInternalDependents === "always" ||
					!satisfies(newVersionOf(next), versionRange))
			if (!needsBump) return type
			if (depType === "devDependencies")
				return type !== "major" && type !== "minor" && type !== "patch" ? "none" : type
			return type !== "major" && type !== "minor" ? "patch" : type
		},
		undefined,
	)
}

// Breadth-first over the releases queue, as `determineDependents` does with its while loop.
const determineDependents = (ctx: Context): boolean => {
	const visit = (queue: ReadonlyArray<MutableRelease>, updated: boolean): boolean => {
		const [next, ...rest] = queue
		if (next === undefined) return updated
		const found = (ctx.graph.get(next.name) ?? []).flatMap((dependent) => {
			const dependentPkg = ctx.byName.get(dependent)
			if (dependentPkg === undefined) return []
			const computed = dependentType(ctx, dependentPkg, next)
			const type = ctx.releases.get(dependent)?.type === computed ? undefined : computed
			return type === undefined
				? []
				: [{ name: dependent, type, oldVersion: dependentPkg.packageJson.version }]
		})
		const added = found.flatMap(({ name, type, oldVersion }) => {
			const existing = ctx.releases.get(name)
			if (existing !== undefined && type === "major" && existing.type !== "major") {
				existing.type = "major"
				return [existing]
			}
			const release: MutableRelease = { name, type, oldVersion, changesets: [] }
			ctx.releases.set(name, release)
			return [release]
		})
		return visit([...rest, ...added], updated || found.length > 0)
	}
	return visit([...ctx.releases.values()], false)
}

const matchFixedConstraint = (ctx: Context): boolean =>
	ctx.config.fixed.reduce((updated, group) => {
		const releasing = [...ctx.releases.values()].filter(
			(r) => group.includes(r.name) && r.type !== "none",
		)
		if (releasing.length === 0) return updated
		const type = highestType(releasing)
		const version = highestVersion(group, ctx.byName)
		return group.reduce((changed, name) => {
			const pkg = ctx.byName.get(name)
			if (pkg === undefined || shouldSkipPackage(pkg, skipOptions(ctx.config))) return changed
			const release = ctx.releases.get(name)
			if (release === undefined) {
				ctx.releases.set(name, { name, type, oldVersion: version, changesets: [] })
				return true
			}
			const differs = release.type !== type || release.oldVersion !== version
			release.type = type
			release.oldVersion = version
			return changed || differs
		}, updated)
	}, false)

const applyLinks = (ctx: Context): boolean =>
	ctx.config.linked.reduce((updated, group) => {
		const releasing = [...ctx.releases.values()].filter(
			(r) => group.includes(r.name) && r.type !== "none",
		)
		if (releasing.length === 0) return updated
		const type = highestType(releasing)
		const version = highestVersion(group, ctx.byName)
		return releasing.reduce((changed, release) => {
			const differs = release.type !== type || release.oldVersion !== version
			release.type = type
			release.oldVersion = version
			return changed || differs
		}, updated)
	}, false)

/** Rejects a changeset naming an unknown package, or mixing skipped and released packages. */
const relevantChangesets = (
	changesets: ReadonlyArray<NewChangeset>,
	byName: ReadonlyMap<string, Package>,
	config: Config,
): Result.Result<ReadonlyArray<NewChangeset>, string> => {
	const problems = changesets.flatMap((changeset) => {
		const unknown = changeset.releases.find((release) => !byName.has(release.name))
		if (unknown !== undefined) {
			return [
				`Found changeset ${changeset.id} for package ${unknown.name} which is not in the workspace`,
			]
		}
		const skipped = changeset.releases.filter((r) => {
			const pkg = byName.get(r.name)
			return pkg !== undefined && shouldSkipPackage(pkg, skipOptions(config))
		})
		const kept = changeset.releases.filter((r) => !skipped.includes(r))
		return skipped.length > 0 && kept.length > 0
			? [
					`Found mixed changeset ${changeset.id}\nFound ignored packages: ${skipped.map((r) => r.name).join(" ")}\nFound not ignored packages: ${kept.map((r) => r.name).join(" ")}\nMixed changesets that contain both ignored and not ignored packages are not allowed`,
				]
			: []
	})
	const [first] = problems
	return first === undefined ? Result.succeed(changesets) : Result.fail(first)
}

export const assembleReleasePlan = (
	changesets: ReadonlyArray<NewChangeset>,
	packages: Packages,
	config: Config,
): Result.Result<ReleasePlan, string> => {
	const byName = new Map(packages.packages.map((pkg) => [pkg.packageJson.name, pkg]))
	return Result.map(relevantChangesets(changesets, byName, config), (relevant) => {
		const ctx: Context = {
			releases: flattenReleases(relevant, byName, config),
			byName,
			rootDir: packages.rootDir,
			graph: dependentsGraph(packages, {
				bumpVersionsWithWorkspaceProtocolOnly: config.bumpVersionsWithWorkspaceProtocolOnly,
			}).graph,
			config,
		}
		const settle = (): void => {
			const dependentAdded = determineDependents(ctx)
			const fixedUpdated = matchFixedConstraint(ctx)
			const linksUpdated = applyLinks(ctx)
			if (dependentAdded || fixedUpdated || linksUpdated) settle()
		}
		settle()
		const releases: ReadonlyArray<ComprehensiveRelease> = [...ctx.releases.values()].map((release) => ({
			name: release.name,
			type: release.type,
			oldVersion: release.oldVersion,
			changesets: release.changesets,
			newVersion: newVersionOf(release),
		}))
		return { changesets: relevant, releases }
	})
}
