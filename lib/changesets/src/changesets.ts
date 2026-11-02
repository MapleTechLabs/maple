/**
 * The `add`, `version` and `status` commands of `@changesets/cli` 3.x, reading and writing the
 * same files. Pre mode, snapshots, `commit` and `publish` are out of scope and fail loudly.
 */
import { Console, Context, Effect, FileSystem, Layer, Option, Path, Predicate, Result, Schema } from "effect"
import {
	type ChangelogFunctions,
	changelogEntry,
	type DependencyUpdateOptions,
	gitChangelog,
	prependEntry,
	type VersionedRelease,
} from "./changelog.ts"
import {
	type Config,
	matchesPatterns,
	normalizeConfig,
	shouldSkipPackage,
	skipOptions,
	skippedDependentErrors,
	validateConfig,
	WrittenConfig,
} from "./config.ts"
import { dependencyEdits, type EditOptions } from "./dependency-edits.ts"
import { dependentsGraph, relativeDirOf } from "./dependents.ts"
import {
	ChangelogError,
	ChangesetParseError,
	CommandExit,
	ConfigError,
	JsonEditError,
	ReleasePlanError,
	UnsupportedFeatureError,
	WorkspaceError,
} from "./errors.ts"
import { Formatter } from "./formatter.ts"
import { parseChangesetFile } from "./frontmatter.ts"
import { Git } from "./git.ts"
import { humanId } from "./human-id.ts"
import { editJson, type JsonEdit } from "./json-edit.ts"
import { assembleReleasePlan } from "./plan.ts"
import type {
	Changeset,
	NewChangeset,
	NewChangesetWithCommit,
	Package,
	Packages,
	ReleasePlan,
} from "./types.ts"
import { getPackages } from "./workspace.ts"

export interface Project {
	readonly packages: Packages
	readonly config: Config
	readonly warnings: ReadonlyArray<string>
}

const ignoredMarkdown = (file: string) =>
	/^README\.md$/i.test(file) || file === "AGENTS.md" || file === "CLAUDE.md" || file === "GEMINI.md"

const encoder = new TextEncoder()

/** libuv's `scandir` order (`strcmp` on UTF-8), which is what `fs.readdir` returns under Node. */
const byteOrder = (a: string, b: string) => {
	const left = encoder.encode(a)
	const right = encoder.encode(b)
	const index = left.findIndex((byte, i) => byte !== right[i])
	if (index === -1) return left.length - right.length
	return (left[index] ?? 0) - (right[index] ?? -1)
}

const readSorted = (fs: FileSystem.FileSystem, dir: string) =>
	Effect.map(fs.readDirectory(dir), (entries) => entries.toSorted(byteOrder))

const builtinChangelogs = new Set(["@changesets/cli/changelog", "@changesets/changelog-git"])

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(WrittenConfig))

export class Changesets extends Context.Service<Changesets>()("@maple/changesets/Changesets", {
	make: Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const git = yield* Git
		const formatter = yield* Formatter

		const workspaceError = (file: string) => (cause: { readonly message: string }) =>
			new WorkspaceError({ message: `Could not access ${file}: ${cause.message}`, path: file, cause })

		const changesetDir = (packages: Packages) => path.join(packages.rootDir, ".changeset")

		const ensureChangesetFolder = (packages: Packages) =>
			Effect.flatMap(
				fs
					.exists(changesetDir(packages))
					.pipe(Effect.mapError(workspaceError(changesetDir(packages)))),
				(exists) =>
					exists
						? Effect.void
						: Effect.fail(
								new CommandExit({
									code: 1,
									message:
										"There is no .changeset folder.\nIf this is the first time Changesets have been used in this project, run `changeset init` to get set up.\nIf you expected there to be changesets, you should check git history for when the folder was removed to ensure you do not lose any configuration.",
								}),
							),
			)

		/** Reads the workspace and `.changeset/config.json`; config rule violations fail. */
		const load = Effect.fn("Changesets.load")(function* (cwd: string) {
			const packages = yield* getPackages(cwd).pipe(
				Effect.catchTag("PlatformError", (e) => workspaceError(cwd)(e)),
			)
			yield* ensureChangesetFolder(packages)
			const file = path.join(changesetDir(packages), "config.json")
			const text = yield* fs.readFileString(file).pipe(Effect.mapError(workspaceError(file)))
			const written = yield* decodeConfig(text).pipe(
				Effect.mapError(
					(cause) =>
						new ConfigError({
							message: `Found issues in your config:\n- ${cause.message}`,
							problems: [cause.message],
						}),
				),
			)
			const config = normalizeConfig(
				written,
				packages.packages.map((pkg) => pkg.packageJson.name),
			)
			const { errors, warnings } = validateConfig(config, written, packages)
			if (errors.length > 0) {
				return yield* new ConfigError({
					message: `Found issues in your config:\n- ${[...warnings, ...errors].join("\n- ")}`,
					problems: [...warnings, ...errors],
				})
			}
			return { packages, config, warnings } satisfies Project
		})

		const refuseUnsupported = Effect.fn("Changesets.refuseUnsupported")(function* (project: Project) {
			const preState = path.join(changesetDir(project.packages), "pre.json")
			if (yield* fs.exists(preState).pipe(Effect.mapError(workspaceError(preState)))) {
				return yield* new UnsupportedFeatureError({
					feature: "pre",
					message:
						"Pre mode (.changeset/pre.json) is not supported by this changesets implementation.",
				})
			}
			if (project.config.commit !== false) {
				return yield* new UnsupportedFeatureError({
					feature: "commit",
					message:
						'The "commit" option is not supported by this changesets implementation; set it to false.',
				})
			}
		})

		/** `@changesets/read`: every changeset in `.changeset` and `.changeset/pre`, in directory order. */
		const readChangesets = Effect.fn("Changesets.readChangesets")(function* (
			packages: Packages,
			since?: string,
		) {
			const base = changesetDir(packages)
			const top = yield* readSorted(fs, base).pipe(Effect.mapError(workspaceError(base)))
			const preDir = path.join(base, "pre")
			const pre = (yield* fs.exists(preDir).pipe(Effect.mapError(workspaceError(preDir))))
				? (yield* readSorted(fs, preDir).pipe(Effect.mapError(workspaceError(preDir)))).map(
						(f) => `pre/${f}`,
					)
				: []
			const changed =
				since === undefined
					? undefined
					: (yield* git.changedChangesetFilesSince(since, base)).map((file) =>
							file.replace(/^.*\.changeset\//, ""),
						)
			const files = [...top, ...pre]
				.filter((file) => changed === undefined || changed.includes(file))
				.filter((file) => {
					const name = path.basename(file)
					return !name.startsWith(".") && name.endsWith(".md") && !ignoredMarkdown(name)
				})
			return yield* Effect.forEach(files, (file) =>
				Effect.gen(function* () {
					const full = path.join(base, file)
					const contents = yield* fs
						.readFileString(full)
						.pipe(Effect.mapError(workspaceError(full)))
					const parsed = parseChangesetFile(contents)
					if (Result.isFailure(parsed))
						return yield* new ChangesetParseError({ message: parsed.failure, file: full })
					return { ...parsed.success, id: file.replace(/\.md$/, "") } satisfies NewChangeset
				}),
			)
		})

		const plan = (changesets: ReadonlyArray<NewChangeset>, packages: Packages, config: Config) => {
			const result = assembleReleasePlan(changesets, packages, config)
			return Result.isSuccess(result)
				? Effect.succeed(result.success)
				: Effect.fail(new ReleasePlanError({ message: result.failure }))
		}

		const logGraphWarnings = (packages: Packages, config: Config) =>
			Effect.forEach(
				dependentsGraph(packages, {
					bumpVersionsWithWorkspaceProtocolOnly: config.bumpVersionsWithWorkspaceProtocolOnly,
				}).invalid,
				(line) => Console.error(line),
				{ discard: true },
			)

		const changelogFunctions = Effect.fn("Changesets.changelogFunctions")(function* (
			reference: readonly [string, unknown],
			packages: Packages,
		) {
			const [specifier] = reference
			if (builtinChangelogs.has(specifier)) return gitChangelog
			if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
				return yield* new UnsupportedFeatureError({
					feature: "changelog",
					message: `Changelog module "${specifier}" is not supported; use "@changesets/cli/changelog", false, or a path relative to .changeset.`,
				})
			}
			const file = path.resolve(changesetDir(packages), specifier)
			const loaded = yield* Effect.tryPromise({
				try: () => import(file),
				catch: (cause) =>
					new ChangelogError({ message: `Could not load ${file}`, module: specifier, cause }),
			})
			return yield* changelogFromModule(loaded, specifier)
		})

		const applyPlan = Effect.fn("Changesets.applyPlan")(function* (
			releasePlan: ReleasePlan,
			packages: Packages,
			config: Config,
		) {
			const byName = new Map(packages.packages.map((pkg) => [pkg.packageJson.name, pkg]))
			const releases = releasePlan.releases.flatMap((release) => {
				const pkg = byName.get(release.name)
				return pkg === undefined
					? []
					: [{ ...release, ...pkg, relativeDir: relativeDirOf(packages.rootDir, pkg) }]
			})
			const updateOptions: DependencyUpdateOptions = {
				rootDir: packages.rootDir,
				updateInternalDependencies: config.updateInternalDependencies,
				onlyUpdatePeerDependentsWhenOutOfRange: config.onlyUpdatePeerDependentsWhenOutOfRange,
			}
			const changelogs = yield* changelogsFor(releasePlan, releases, packages, config, updateOptions)
			const editOptions: EditOptions = {
				...updateOptions,
				bumpVersionsWithWorkspaceProtocolOnly: config.bumpVersionsWithWorkspaceProtocolOnly,
			}
			const written = yield* Effect.forEach(releases, (release, index) =>
				Effect.gen(function* () {
					const versionEdit: ReadonlyArray<JsonEdit> =
						release.newVersion === undefined
							? []
							: [{ keys: ["version"], value: release.newVersion }]
					yield* updatePackageJson(release, [
						...dependencyEdits(release.packageJson, releases, editOptions),
						...versionEdit,
					])
					const changelog = changelogs[index]
					if (changelog === undefined || changelog.length === 0) return Option.none<string>()
					const file = path.resolve(release.dir, "CHANGELOG.md")
					const existing = yield* fs.readFileString(file).pipe(
						Effect.map(Option.some),
						Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
						Effect.mapError(workspaceError(file)),
					)
					yield* fs
						.writeFileString(
							file,
							prependEntry(Option.getOrUndefined(existing), changelog, release.name),
						)
						.pipe(Effect.mapError(workspaceError(file)))
					return Option.some(file)
				}),
			)
			yield* updatePackageJson(
				packages.rootPackage,
				dependencyEdits(packages.rootPackage.packageJson, releases, editOptions),
			)
			yield* formatter.format(config.format, packages.rootDir, written.flatMap(Option.toArray))
			yield* Effect.forEach(
				releasePlan.changesets,
				(changeset) =>
					Effect.gen(function* () {
						const file = path.resolve(changesetDir(packages), `${changeset.id}.md`)
						const skipped = changeset.releases.some((r) => {
							const pkg = byName.get(r.name)
							return pkg !== undefined && shouldSkipPackage(pkg, skipOptions(config))
						})
						if (skipped || !(yield* fs.exists(file).pipe(Effect.mapError(workspaceError(file)))))
							return
						yield* fs.remove(file, { force: true }).pipe(Effect.mapError(workspaceError(file)))
					}),
				{ discard: true },
			)
		})

		const changelogsFor = Effect.fn("Changesets.changelogsFor")(function* (
			releasePlan: ReleasePlan,
			releases: ReadonlyArray<VersionedRelease & Package>,
			packages: Packages,
			config: Config,
			options: DependencyUpdateOptions,
		) {
			if (config.changelog === false) return releases.map(() => undefined)
			const functions = yield* changelogFunctions(config.changelog, packages)
			const commits = yield* git.commitsThatAddFiles(
				releasePlan.changesets.map((changeset) => `.changeset/${changeset.id}.md`),
				packages.rootDir,
			)
			const withCommits: ReadonlyArray<NewChangesetWithCommit> = releasePlan.changesets.map(
				(changeset, i) => ({
					...changeset,
					commit: commits[i],
				}),
			)
			return yield* Effect.forEach(releases, (release) =>
				changelogEntry(
					release,
					releases,
					withCommits,
					functions,
					config.changelog === false ? null : config.changelog[1],
					options,
				),
			)
		})

		const updatePackageJson = (pkg: Package, edits: ReadonlyArray<JsonEdit>) =>
			Effect.gen(function* () {
				if (edits.length === 0) return
				const file = path.resolve(pkg.dir, "package.json")
				const text = yield* fs.readFileString(file).pipe(Effect.mapError(workspaceError(file)))
				const edited = editJson(text, edits)
				if (Result.isFailure(edited))
					return yield* new JsonEditError({ message: edited.failure, file })
				yield* fs.writeFileString(file, edited.success).pipe(Effect.mapError(workspaceError(file)))
			})

		/** `changeset version [--ignore pkg]`. */
		const version = Effect.fn("Changesets.version")(function* (options: {
			readonly cwd: string
			readonly ignore?: ReadonlyArray<string> | undefined
		}) {
			const project = yield* load(options.cwd)
			yield* Effect.forEach(project.warnings, (warning) => Console.warn(warning), { discard: true })
			const { packages } = project
			const messages: Array<string> = []
			const cliIgnore =
				options.ignore !== undefined && options.ignore.length > 0 ? options.ignore : undefined
			if (cliIgnore !== undefined && project.config.ignore.length > 0) {
				messages.push(
					"It looks like you are trying to use the `--ignore` option while ignore is defined in the config file. This is currently not allowed, you can only use one of them at a time.",
				)
			}
			const config: Config = { ...project.config, ignore: cliIgnore ?? project.config.ignore }
			const names = new Set(packages.packages.map((pkg) => pkg.packageJson.name))
			;(cliIgnore ?? [])
				.filter((name) => !names.has(name))
				.forEach((name) =>
					messages.push(
						`The package ${name} is passed to the \`--ignore\` option but it is not found in the project. You may have misspelled the package name.`,
					),
				)
			skippedDependentErrors(packages, config).forEach(({ dependent, skipped }) =>
				messages.push(
					`The package ${dependent} depends on the skipped package ${skipped} (either by \`ignore\` option or by \`privatePackages.version\`), but ${dependent} is not being skipped. Please pass ${dependent} to the --ignore flag.`,
				),
			)
			if (messages.length > 0) return yield* new CommandExit({ code: 1, message: messages.join("\n") })
			yield* refuseUnsupported(project)
			const changesets = yield* readChangesets(packages)
			if (changesets.length === 0) {
				return yield* new CommandExit({ code: 1, message: "No unreleased changesets found." })
			}
			yield* logGraphWarnings(packages, config)
			const releasePlan = yield* plan(changesets, packages, config)
			yield* applyPlan(releasePlan, packages, config)
			return releasePlan
		})

		/** Workspace packages changed since `ref` that changesets would version. */
		const changedPackages = Effect.fn("Changesets.changedPackages")(function* (
			project: Project,
			ref?: string,
		) {
			const files = [
				...(yield* git.changedFilesSince(ref ?? project.config.baseBranch, project.packages.rootDir)),
			]
			const deepestFirst = project.packages.packages.toSorted((a, b) => b.dir.length - a.dir.length)
			const changed = deepestFirst.filter((pkg) => {
				const owned = files.filter((file) => !path.relative(pkg.dir, file).startsWith(".."))
				owned.forEach((file) => files.splice(files.indexOf(file), 1))
				const relative = owned.map((file) => file.slice(pkg.dir.length + 1))
				return relative.length > 0 && matchesSome(relative, project.config.changedFilePatterns)
			})
			return changed.filter((pkg) => !shouldSkipPackage(pkg, skipOptions(project.config)))
		})

		/** `changeset status [--since ref] [--output file]`. */
		const status = Effect.fn("Changesets.status")(function* (options: {
			readonly cwd: string
			readonly since?: string | undefined
			readonly output?: string | undefined
		}) {
			const project = yield* load(options.cwd)
			yield* refuseUnsupported(project)
			const changesets = yield* readChangesets(project.packages, options.since)
			const releasePlan = yield* plan(changesets, project.packages, project.config)
			const changed = yield* changedPackages(project, options.since)
			if (changed.length > 0 && releasePlan.changesets.length === 0) {
				return yield* new CommandExit({
					code: 1,
					message:
						"Some packages have been changed but no changesets were found. Run `changeset add` to resolve this error.\nIf this change doesn't need a release, run `changeset add --empty`.",
				})
			}
			if (options.output !== undefined) {
				const file = path.resolve(options.cwd, options.output)
				yield* fs
					.writeFileString(file, JSON.stringify(releasePlan, undefined, 2))
					.pipe(Effect.mapError(workspaceError(file)))
			}
			return releasePlan
		})

		/** `@changesets/write`: a new `.changeset/<human-id>.md`, formatted like the project. */
		const writeChangeset = Effect.fn("Changesets.writeChangeset")(function* (
			project: Project,
			changeset: Changeset,
		) {
			const base = changesetDir(project.packages)
			const pickId: Effect.Effect<string, WorkspaceError> = Effect.flatMap(humanId, (id) =>
				Effect.flatMap(
					fs.exists(path.join(base, `${id}.md`)).pipe(Effect.mapError(workspaceError(base))),
					(taken) => (taken ? pickId : Effect.succeed(id)),
				),
			)
			const id = yield* pickId
			const file = path.join(base, `${id}.md`)
			const contents = `---\n${changeset.releases.map((r) => `"${r.name}": ${r.type}`).join("\n")}\n---\n\n${changeset.summary}\n`
			yield* fs.makeDirectory(base, { recursive: true }).pipe(Effect.mapError(workspaceError(base)))
			yield* fs.writeFileString(file, contents).pipe(Effect.mapError(workspaceError(file)))
			yield* formatter.format(project.config.format, project.packages.rootDir, [file])
			return { id, file }
		})

		return { load, refuseUnsupported, readChangesets, version, status, changedPackages, writeChangeset }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide([Git.layer, Formatter.layer]))
}

const matchesSome = (paths: ReadonlyArray<string>, patterns: ReadonlyArray<string>) =>
	paths.some((file) => matchesPatterns(file.replaceAll("\\", "/"), patterns))

// The changesets changelog module contract: each function returns a line, possibly as a promise.
type ModuleFunction = (...args: ReadonlyArray<unknown>) => string | PromiseLike<string>

interface ModuleFunctions {
	readonly getReleaseLine: ModuleFunction
	readonly getDependencyReleaseLine: ModuleFunction
}

const isModuleFunction = (value: unknown): value is ModuleFunction => typeof value === "function"

// changesets reads `module`, else `module.default`, else `module.default.default`.
const findFunctions = (module: unknown, depth: number): Option.Option<ModuleFunctions> => {
	if (Predicate.hasProperty(module, "default") && module.default && depth < 2) {
		return findFunctions(module.default, depth + 1)
	}
	return Predicate.hasProperty(module, "getReleaseLine") &&
		Predicate.hasProperty(module, "getDependencyReleaseLine") &&
		isModuleFunction(module.getReleaseLine) &&
		isModuleFunction(module.getDependencyReleaseLine)
		? Option.some({
				getReleaseLine: module.getReleaseLine,
				getDependencyReleaseLine: module.getDependencyReleaseLine,
			})
		: Option.none()
}

const callModule = (fn: ModuleFunction, args: ReadonlyArray<unknown>, specifier: string) =>
	Effect.tryPromise({
		try: () => Promise.resolve(fn(...args)),
		catch: (cause) =>
			new ChangelogError({ message: `Changelog module ${specifier} failed`, module: specifier, cause }),
	}).pipe(Effect.map((line) => (typeof line === "string" ? line : String(line ?? ""))))

/** Adapts a changelog module (`getReleaseLine`, `getDependencyReleaseLine`) to Effects. */
const changelogFromModule = (
	module: unknown,
	specifier: string,
): Effect.Effect<ChangelogFunctions, ChangelogError> =>
	Option.match(findFunctions(module, 0), {
		onNone: () =>
			Effect.fail(
				new ChangelogError({
					message: "Could not resolve changelog generation functions",
					module: specifier,
				}),
			),
		onSome: ({ getReleaseLine, getDependencyReleaseLine }) =>
			Effect.succeed({
				getReleaseLine: (changeset, type, options) =>
					callModule(getReleaseLine, [changeset, type, options], specifier),
				getDependencyReleaseLine: (changesets, dependencies, options) =>
					callModule(getDependencyReleaseLine, [changesets, dependencies, options], specifier),
			}),
	})
