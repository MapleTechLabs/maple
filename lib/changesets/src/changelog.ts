/**
 * CHANGELOG.md entries byte-for-byte as `@changesets/apply-release-plan` writes them with the
 * default `@changesets/cli/changelog` (which is `@changesets/changelog-git`).
 */
import { Effect } from "effect"
import type { ChangelogError } from "./errors.ts"
import { isValidRange, satisfies } from "./semver.ts"
import type { ComprehensiveRelease, NewChangesetWithCommit, PackageJson, VersionType } from "./types.ts"

export interface DependencyRelease {
	readonly name: string
	readonly newVersion: string | undefined
}

/** The second element of `changelog: [module, options]` in the config, handed to the module. */
export type ChangelogOptions = Readonly<Record<string, unknown>> | null

/** The changesets changelog module contract, with Effects instead of promises. */
export interface ChangelogFunctions {
	readonly getReleaseLine: (
		changeset: NewChangesetWithCommit,
		type: VersionType,
		options: ChangelogOptions,
	) => Effect.Effect<string, ChangelogError>
	readonly getDependencyReleaseLine: (
		changesets: ReadonlyArray<NewChangesetWithCommit>,
		dependenciesUpdated: ReadonlyArray<DependencyRelease>,
		options: ChangelogOptions,
	) => Effect.Effect<string, ChangelogError>
}

const shortCommit = (commit: string | undefined) => (commit ? commit.slice(0, 7) : undefined)

/** `@changesets/changelog-git`. */
export const gitChangelog: ChangelogFunctions = {
	getReleaseLine: (changeset) => {
		const [firstLine, ...futureLines] = changeset.summary.split("\n").map((line) => line.trimEnd())
		const commit = shortCommit(changeset.commit)
		const head = `- ${commit === undefined ? "" : `${commit}: `}${firstLine}`
		return Effect.succeed(
			futureLines.length > 0 ? `${head}\n${futureLines.map((line) => `  ${line}`).join("\n")}` : head,
		)
	},
	getDependencyReleaseLine: (changesets, dependenciesUpdated) => {
		if (dependenciesUpdated.length === 0) return Effect.succeed("")
		const links = changesets.map((changeset) => {
			const commit = shortCommit(changeset.commit)
			return `- Updated dependencies${commit === undefined ? "" : ` [${commit}]`}`
		})
		const list = dependenciesUpdated.map(
			(dependency) => `  - ${dependency.name}@${dependency.newVersion}`,
		)
		return Effect.succeed([...links, ...list].join("\n"))
	},
}

const bumpLevel = { none: 0, patch: 1, minor: 2, major: 3 } as const satisfies Record<VersionType, number>

export interface DependencyUpdateOptions {
	readonly rootDir: string
	readonly updateInternalDependencies: "minor" | "patch"
	readonly onlyUpdatePeerDependentsWhenOutOfRange: boolean
}

export interface VersionedRelease extends ComprehensiveRelease {
	readonly relativeDir: string
}

/** `shouldUpdateDependencyBasedOnConfig`. */
export const shouldUpdateDependency = (
	release: VersionedRelease,
	depVersionRange: string,
	depType: string,
	options: DependencyUpdateOptions,
): boolean => {
	if (release.newVersion === undefined) return false
	const workspace = depVersionRange.startsWith("workspace:")
	const stripped = workspace ? depVersionRange.slice("workspace:".length) : depVersionRange
	if (workspace && stripped === "*") return true
	if (workspace && stripped !== "^" && stripped !== "~" && !isValidRange(stripped)) {
		return normalizePath(stripped) === release.relativeDir
	}
	const range =
		workspace && (stripped === "^" || stripped === "~") ? `${stripped}${release.oldVersion}` : stripped
	if (!satisfies(release.newVersion, range)) return true
	if (depType === "peerDependencies") return !options.onlyUpdatePeerDependentsWhenOutOfRange
	return bumpLevel[release.type] >= bumpLevel[options.updateInternalDependencies]
}

const normalizePath = (path: string) =>
	path
		.split("/")
		.reduce<Array<string>>((parts, part) => {
			if (part === "" || part === ".") return parts
			if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") return parts.slice(0, -1)
			return [...parts, part]
		}, [])
		.join("/") || "."

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** `generateMarkdownForVersionType`: joins release lines, keeping at most one blank line between them. */
const markdownForType = (type: "major" | "minor" | "patch", lines: ReadonlyArray<string>) => {
	const releaseLines = lines.filter((line) => line)
	if (releaseLines.length === 0) return undefined
	return releaseLines.reduce(
		({ content, newLines }, line) => {
			const leading = newLines + (/^\n*/.exec(line)?.[0].length ?? 0)
			return {
				content: content + "\n".repeat(Math.min(Math.max(leading, 1), 2)) + line.trim(),
				newLines: /\n*$/.exec(line)?.[0].length ?? 0,
			}
		},
		{ content: `### ${capitalize(type)} Changes`, newLines: 2 },
	).content
}

/** `getChangelogEntry` for one release; `undefined` for a release that does not bump. */
export const changelogEntry = Effect.fn("changelogEntry")(function* (
	release: VersionedRelease & { readonly packageJson: PackageJson },
	releases: ReadonlyArray<VersionedRelease>,
	changesets: ReadonlyArray<NewChangesetWithCommit>,
	functions: ChangelogFunctions,
	functionOptions: ChangelogOptions,
	options: DependencyUpdateOptions,
) {
	if (release.type === "none") return undefined
	const linesOf = (type: "major" | "minor" | "patch") =>
		Effect.forEach(
			changesets.flatMap((changeset) => {
				const own = changeset.releases.find((r) => r.name === release.name)
				return own !== undefined && own.type === type ? [changeset] : []
			}),
			(changeset) => functions.getReleaseLine(changeset, type, functionOptions),
		)
	const dependentReleases = releases.filter((rel) => {
		const dependencyRange = release.packageJson.dependencies?.[rel.name]
		const peerRange = release.packageJson.peerDependencies?.[rel.name]
		const versionRange = dependencyRange || peerRange
		return (
			versionRange !== undefined &&
			versionRange !== "" &&
			(versionRange.startsWith("workspace:") || isValidRange(versionRange)) &&
			shouldUpdateDependency(
				rel,
				versionRange,
				dependencyRange ? "dependencies" : "peerDependencies",
				options,
			)
		)
	})
	const relevantIds = new Set(dependentReleases.flatMap((rel) => rel.changesets))
	const major = yield* linesOf("major")
	const minor = yield* linesOf("minor")
	const patch = yield* linesOf("patch")
	const dependencyLine = yield* functions.getDependencyReleaseLine(
		changesets.filter((changeset) => relevantIds.has(changeset.id)),
		dependentReleases,
		functionOptions,
	)
	const rendered = [
		`## ${release.newVersion}`,
		markdownForType("major", major),
		markdownForType("minor", minor),
		markdownForType("patch", [...patch, dependencyLine]),
	].filter((line): line is string => line !== undefined && line !== "")
	return (rendered.length === 1 ? [...rendered, "No changes in this release."] : rendered).join("\n\n")
})

/** `updateChangelog`: the new entry goes above the first version heading, or under the title. */
export const prependEntry = (existing: string | undefined, entry: string, packageName: string): string => {
	const template = `\n\n${entry.trim()}\n`
	if (existing === undefined || existing === "") return `# ${packageName}${template}`
	const firstVersionHeading = existing.search(/^#{1,6}\s+\d+\.\d+/m)
	if (firstVersionHeading >= 0) {
		return (
			existing.slice(0, firstVersionHeading) +
			template.trimStart() +
			"\n" +
			existing.slice(firstVersionHeading)
		)
	}
	const newline = existing.indexOf("\n")
	return newline === -1
		? existing + template
		: existing.slice(0, newline) + template + existing.slice(newline + 1)
}
