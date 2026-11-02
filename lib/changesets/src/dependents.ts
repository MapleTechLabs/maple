/** `@changesets/get-dependents-graph`: which workspace packages depend on which. */
import { isValidRange, satisfies } from "./semver.ts"
import { DEPENDENCY_TYPES, type Package, type PackageJson, type Packages } from "./types.ts"

export interface GraphOptions {
	readonly ignoreDevDependencies?: boolean
	readonly bumpVersionsWithWorkspaceProtocolOnly?: boolean
}

export interface DependentsGraph {
	/** Package name to the names of the packages that depend on it, in workspace order. */
	readonly graph: ReadonlyMap<string, ReadonlyArray<string>>
	/** Ranges that do not admit the current version, which changesets reports and skips. */
	readonly invalid: ReadonlyArray<string>
}

const allDependencies = (json: PackageJson, ignoreDevDependencies: boolean) =>
	DEPENDENCY_TYPES.reduce((all, type) => {
		Object.entries(json[type] ?? {}).forEach(([name, range]) => {
			if (
				type === "devDependencies" &&
				(ignoreDevDependencies || range.startsWith("link:") || range.startsWith("file:"))
			)
				return
			all.set(name, range)
		})
		return all
	}, new Map<string, string>())

const isProtocolRange = (range: string) => range.includes(":")
const isUsableRange = (range: string) => !isProtocolRange(range) && isValidRange(range)
const normalizePosix = (path: string) =>
	path
		.split("/")
		.reduce<Array<string>>((parts, part) => {
			if (part === "" || part === ".") return parts
			if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") return parts.slice(0, -1)
			return [...parts, part]
		}, [])
		.join("/") || "."

export const relativeDirOf = (rootDir: string, pkg: Package) =>
	pkg.dir === rootDir ? "." : pkg.dir.slice(rootDir.length + 1).replaceAll("\\", "/")

export const workspacePathMatches = (range: string, rootDir: string, pkg: Package) =>
	normalizePosix(range) === relativeDirOf(rootDir, pkg)

const dependenciesOf = (
	pkg: Package,
	byName: ReadonlyMap<string, Package>,
	rootDir: string,
	options: GraphOptions,
	invalid: Array<string>,
): ReadonlyArray<string> =>
	[...allDependencies(pkg.packageJson, options.ignoreDevDependencies ?? false)].flatMap(
		([name, rawRange]) => {
			const match = byName.get(name)
			if (match === undefined) return []
			const expected = match.packageJson.version
			const report = () => {
				invalid.push(
					`Package ${pkg.packageJson.name} must depend on the current version of ${name}: ${expected} vs ${rawRange}`,
				)
				return []
			}
			if (rawRange.startsWith("workspace:")) {
				const range = rawRange.slice("workspace:".length)
				if (range === "*" || range === "^" || range === "~") return [name]
				if (workspacePathMatches(range, rootDir, match)) return [name]
				if (!isUsableRange(range)) return report()
				return satisfies(expected, range) ? [name] : report()
			}
			if (options.bumpVersionsWithWorkspaceProtocolOnly === true) return []
			if (isProtocolRange(rawRange)) return report()
			if (!isUsableRange(rawRange)) return []
			return satisfies(expected, rawRange) ? [name] : report()
		},
	)

export const dependentsGraph = (packages: Packages, options: GraphOptions = {}): DependentsGraph => {
	const byName = new Map<string, Package>([
		[packages.rootPackage.packageJson.name, packages.rootPackage],
		...packages.packages.map((pkg) => [pkg.packageJson.name, pkg] as const),
	])
	const invalid: Array<string> = []
	const graph = new Map<string, Array<string>>([
		[packages.rootPackage.packageJson.name, []],
		...packages.packages.map((pkg) => [pkg.packageJson.name, []] as [string, Array<string>]),
	])
	// The root's own dependencies are parsed (and reported) but it is never anyone's dependent.
	dependenciesOf(packages.rootPackage, byName, packages.rootDir, options, invalid)
	packages.packages.forEach((pkg) => {
		dependenciesOf(pkg, byName, packages.rootDir, options, invalid).forEach((dependency) =>
			graph.get(dependency)?.push(pkg.packageJson.name),
		)
	})
	return { graph, invalid }
}
