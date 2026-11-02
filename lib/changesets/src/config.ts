/** `.changeset/config.json`: the written schema, its defaults, and the `@changesets/config` rules. */
import { Glob, Schema } from "effect"
import { dependentsGraph } from "./dependents.ts"
import type { Package, Packages } from "./types.ts"

const ModuleTuple = Schema.Tuple([Schema.String, Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))])

export const WrittenConfig = Schema.Struct({
	baseBranch: Schema.optionalKey(Schema.String),
	access: Schema.optionalKey(Schema.Literals(["public", "restricted"])),
	changedFilePatterns: Schema.optionalKey(Schema.Array(Schema.String)),
	format: Schema.optionalKey(Schema.Literals(["auto", "prettier", "oxfmt", "deno", "dprint", false])),
	ignore: Schema.optionalKey(Schema.Array(Schema.String)),
	fixed: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String))),
	linked: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String))),
	updateInternalDependencies: Schema.optionalKey(Schema.Literals(["minor", "patch"])),
	privatePackages: Schema.optionalKey(
		Schema.Union([
			Schema.Struct({
				version: Schema.optionalKey(Schema.Boolean),
				tag: Schema.optionalKey(Schema.Boolean),
			}),
			Schema.Boolean,
		]),
	),
	bumpVersionsWithWorkspaceProtocolOnly: Schema.optionalKey(Schema.Boolean),
	snapshot: Schema.optionalKey(
		Schema.Struct({
			useCalculatedVersion: Schema.optionalKey(Schema.Boolean),
			prereleaseTemplate: Schema.optionalKey(Schema.String),
		}),
	),
	changelog: Schema.optionalKey(Schema.Union([Schema.Literal(false), Schema.String, ModuleTuple])),
	commit: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String, ModuleTuple])),
	___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH: Schema.optionalKey(
		Schema.Struct({
			onlyUpdatePeerDependentsWhenOutOfRange: Schema.optionalKey(Schema.Boolean),
			updateInternalDependents: Schema.optionalKey(Schema.Literals(["always", "out-of-range"])),
		}),
	),
})
export type WrittenConfig = typeof WrittenConfig.Type

export type ModuleReference = readonly [string, Readonly<Record<string, unknown>> | null]
export type FormatterName = "prettier" | "oxfmt" | "deno" | "dprint"

export interface Config {
	readonly baseBranch: string
	readonly access: "public" | "restricted"
	readonly changedFilePatterns: ReadonlyArray<string>
	readonly format: "auto" | FormatterName | false
	readonly ignore: ReadonlyArray<string>
	readonly fixed: ReadonlyArray<ReadonlyArray<string>>
	readonly linked: ReadonlyArray<ReadonlyArray<string>>
	readonly updateInternalDependencies: "minor" | "patch"
	readonly privatePackages: { readonly version: boolean; readonly tag: boolean }
	readonly bumpVersionsWithWorkspaceProtocolOnly: boolean
	readonly snapshot: {
		readonly useCalculatedVersion: boolean
		readonly prereleaseTemplate: string | undefined
	}
	readonly changelog: ModuleReference | false
	readonly commit: ModuleReference | false
	readonly onlyUpdatePeerDependentsWhenOutOfRange: boolean
	readonly updateInternalDependents: "always" | "out-of-range"
}

/** A picomatch-style matcher: a `!pattern` matches what `pattern` does not. */
const matcher = (pattern: string) => {
	const negated = pattern.startsWith("!")
	const glob = Glob.make(negated ? pattern.slice(1) : pattern)
	return { negated, test: (value: string) => negated !== Glob.match(glob, value) }
}

/** changesets' glob reduction: a positive pattern admits, a later `!pattern` it matches takes back. */
export const matchesPatterns = (value: string, patterns: ReadonlyArray<string>): boolean =>
	patterns
		.map(matcher)
		.reduce((passed, m) => (passed ? !(m.negated && !m.test(value)) : !m.negated && m.test(value)), false)

const globMatch = (names: ReadonlyArray<string>, patterns: ReadonlyArray<string>) =>
	names.filter((name) => matchesPatterns(name, patterns))

// `"module"` means `["module", null]`; `commit: true` means the default commit module.
const moduleReference = (
	value: string | ModuleReference | boolean | undefined,
	fallback: ModuleReference | false,
): ModuleReference | false => {
	if (value === undefined) return fallback
	if (typeof value === "string") return [value, null]
	if (value === true) return ["@changesets/cli/commit", { skipCI: "version" }]
	return value
}

/** `normalizeWrittenConfig`: fills defaults and expands package-name globs. */
export const normalizeConfig = (written: WrittenConfig, packageNames: ReadonlyArray<string>): Config => ({
	baseBranch: written.baseBranch ?? "main",
	access: written.access ?? "restricted",
	changedFilePatterns: written.changedFilePatterns ?? ["**"],
	format: written.format ?? "auto",
	ignore: globMatch(packageNames, written.ignore ?? []),
	fixed: (written.fixed ?? []).map((group) => globMatch(packageNames, group)),
	linked: (written.linked ?? []).map((group) => globMatch(packageNames, group)),
	updateInternalDependencies: written.updateInternalDependencies ?? "patch",
	privatePackages:
		typeof written.privatePackages === "boolean"
			? { version: written.privatePackages, tag: written.privatePackages }
			: {
					version: written.privatePackages?.version ?? false,
					tag: written.privatePackages?.tag ?? false,
				},
	bumpVersionsWithWorkspaceProtocolOnly: written.bumpVersionsWithWorkspaceProtocolOnly ?? false,
	snapshot: {
		useCalculatedVersion: written.snapshot?.useCalculatedVersion ?? false,
		prereleaseTemplate: written.snapshot?.prereleaseTemplate,
	},
	changelog: moduleReference(written.changelog, ["@changesets/cli/changelog", null]),
	commit: moduleReference(written.commit, false),
	onlyUpdatePeerDependentsWhenOutOfRange:
		written.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH?.onlyUpdatePeerDependentsWhenOutOfRange ??
		false,
	updateInternalDependents:
		written.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH?.updateInternalDependents ?? "out-of-range",
})

/** `shouldSkipPackage`: ignored, private without `privatePackages.version`, or versionless. */
export const shouldSkipPackage = (
	{ packageJson }: Package,
	{
		ignore,
		allowPrivatePackages,
	}: { readonly ignore: ReadonlyArray<string>; readonly allowPrivatePackages: boolean },
): boolean =>
	ignore.includes(packageJson.name) ||
	(packageJson.private === true && !allowPrivatePackages) ||
	!packageJson.version

export const skipOptions = (config: Config) => ({
	ignore: config.ignore,
	allowPrivatePackages: config.privatePackages.version,
})

const picomatchNote = `Note that glob expressions must be defined according to https://npmx.dev/picomatch.`

const unmatched = (patterns: ReadonlyArray<string>, names: ReadonlyArray<string>) =>
	patterns.filter((pattern) => !names.some((name) => matcher(pattern).test(name)))

const duplicates = (groups: ReadonlyArray<ReadonlyArray<string>>) => {
	const flat = groups.flat()
	return [...new Set(flat.filter((name, index) => flat.indexOf(name) !== index))]
}

export interface ConfigProblems {
	readonly errors: ReadonlyArray<string>
	readonly warnings: ReadonlyArray<string>
}

/** The `@changesets/config` validation rules, in the same order and wording. */
export const validateConfig = (
	config: Config,
	written: WrittenConfig,
	packages: Packages,
): ConfigProblems => {
	const names = packages.packages.map((pkg) => pkg.packageJson.name)
	const groupWarnings = (
		kind: "fixed" | "linked",
		groups: ReadonlyArray<ReadonlyArray<string>> | undefined,
	) =>
		config[kind].length === 0
			? []
			: (groups ?? []).flatMap((group) =>
					unmatched(group, names).map(
						(pattern) =>
							`${kind}: Invalid path: The package or glob "${pattern}" does not match any package in the project. ${picomatchNote}`,
					),
				)
	const groupErrors = (kind: "fixed" | "linked") =>
		duplicates(config[kind]).map(
			(name) =>
				`${kind}: Invalid group: The package or glob "${name}" is defined in multiple groups of ${kind} packages. Packages can only be belong to a single group. ${picomatchNote}`,
		)
	const linkedNames = new Set(config.linked.flat())
	const fixedAndLinked =
		config.fixed.length === 0 || config.linked.length === 0
			? []
			: [...new Set(config.fixed.flat())]
					.filter((name) => linkedNames.has(name))
					.map(
						(name) =>
							`Invalid group: The package "${name}" can be found in both fixed and linked groups. A package can only be either fixed or linked.`,
					)
	const skipped =
		config.ignore.length === 0 && config.privatePackages.version
			? []
			: skippedDependentErrors(packages, config).map(
					({ dependent, skipped }) =>
						`Invalid tree: "${dependent}" depends on the skipped package "${skipped}", but "${dependent}" is not skipped. Please add "${dependent}" to the "ignore" option.`,
				)
	const privateTag =
		config.privatePackages.version === false && config.privatePackages.tag === true
			? [
					`privatePackages: Invalid combination: "tag" is set to "true" but "version" is set to "false".`,
				]
			: []
	return {
		warnings: [...groupWarnings("fixed", written.fixed), ...groupWarnings("linked", written.linked)],
		errors: [
			...groupErrors("fixed"),
			...groupErrors("linked"),
			...fixedAndLinked,
			...skipped,
			...privateTag,
		],
	}
}

/** Public packages that depend (outside devDependencies) on a package changesets skips. */
export const skippedDependentErrors = (packages: Packages, config: Config) => {
	const graph = dependentsGraph(packages, {
		ignoreDevDependencies: true,
		bumpVersionsWithWorkspaceProtocolOnly: config.bumpVersionsWithWorkspaceProtocolOnly,
	}).graph
	const byName = new Map(packages.packages.map((pkg) => [pkg.packageJson.name, pkg]))
	return packages.packages
		.filter((pkg) => shouldSkipPackage(pkg, skipOptions(config)))
		.flatMap((pkg) =>
			(graph.get(pkg.packageJson.name) ?? []).flatMap((dependent) => {
				const dependentPkg = byName.get(dependent)
				return dependentPkg === undefined ||
					shouldSkipPackage(dependentPkg, skipOptions(config)) ||
					dependentPkg.packageJson.private === true
					? []
					: [{ dependent, skipped: pkg.packageJson.name }]
			}),
		)
}
