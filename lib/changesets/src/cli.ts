/**
 * The `changeset` command line: `add` (also the default), `version` and `status` with the
 * `@changesets/cli` 3.x flags. Editors are spawned without a shell, `$EDITOR` split on whitespace.
 */
import { Config, Console, Effect, FileSystem, Option, Path, Predicate } from "effect"
import { Command, Flag, Prompt } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Changesets, type Project } from "./changesets.ts"
import { shouldSkipPackage, skipOptions } from "./config.ts"
import { CommandExit, UnsupportedFeatureError } from "./errors.ts"
import { lessThan, type BumpType } from "./semver.ts"
import type { ComprehensiveRelease, Package, Release } from "./types.ts"

const version = "3.0.3-maple"

const listFlag = (name: string, description: string) =>
	Flag.String(name).pipe(
		Flag.withDescription(description),
		Flag.atLeast(0),
		Flag.map((values) =>
			values.flatMap((value) =>
				value
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean),
			),
		),
	)

const addFlags = {
	empty: Flag.Boolean("empty").pipe(
		Flag.withDescription("Add an empty changeset"),
		Flag.withDefault(false),
	),
	open: Flag.Boolean("open").pipe(
		Flag.withDescription("Open the changeset in $VISUAL or $EDITOR after creating it"),
		Flag.withDefault(false),
	),
	since: Flag.String("since").pipe(
		Flag.withDescription("Detect changed packages since the provided git ref"),
		Flag.optional,
	),
	message: Flag.String("message").pipe(
		Flag.withAlias("m"),
		Flag.withDescription("Directly provide a message to the changeset"),
		Flag.optional,
	),
	major: listFlag("major", "Package(s) to major bump (comma-separated)"),
	minor: listFlag("minor", "Package(s) to minor bump (comma-separated)"),
	patch: listFlag("patch", "Package(s) to patch bump (comma-separated)"),
}

interface AddOptions {
	readonly empty: boolean
	readonly open: boolean
	readonly since: Option.Option<string>
	readonly message: Option.Option<string>
	readonly major: ReadonlyArray<string>
	readonly minor: ReadonlyArray<string>
	readonly patch: ReadonlyArray<string>
}

const cwd = Effect.gen(function* () {
	const path = yield* Path.Path
	return path.resolve(".")
})

const success = (message: string) => Console.log(`🦋  ${message}`)
const warn = (message: string) => Console.warn(`🦋  warn ${message.split("\n").join("\n🦋  warn ")}`)

const ask = <A>(prompt: Prompt.Prompt<A>) =>
	Prompt.run(prompt).pipe(
		Effect.catchTag("QuitError", () =>
			Effect.fail(new CommandExit({ code: 0, message: "Canceled... 👋" })),
		),
	)

const editorCommand = Effect.gen(function* () {
	const visual = yield* Config.option(Config.String("VISUAL"))
	const editor = yield* Config.option(Config.String("EDITOR"))
	return Option.orElse(visual, () => editor).pipe(
		Option.map((value) => value.trim().split(/\s+/)),
		Option.filter((parts) => parts.length > 0 && parts[0] !== ""),
	)
}).pipe(Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()))

/** Opens `file` in the user's editor and waits for it to exit. */
const openInEditor = (file: string) =>
	Effect.gen(function* () {
		const command = yield* editorCommand
		if (Option.isNone(command)) return false
		const [bin = "", ...args] = command.value
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const exit = yield* spawner.exitCode(
			ChildProcess.make(bin, [...args, file], {
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			}),
		)
		return Number(exit) === 0
	}).pipe(Effect.orElseSucceed(() => false))

const summaryFromEditor = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const dir = yield* fs.makeTempDirectory()
	const file = path.join(dir, "changeset.md")
	yield* fs.writeFileString(
		file,
		"\n\n# Please enter a summary for your changes.\n# An empty message aborts the editor.",
	)
	const opened = yield* openInEditor(file)
	const contents = opened ? yield* fs.readFileString(file) : ""
	yield* fs.remove(dir, { recursive: true })
	return contents
		.replace(/^#.*\n?/gm, "")
		.replace(/\n+$/g, "")
		.trim()
}).pipe(Effect.orElseSucceed(() => ""))

const askSummary = Effect.gen(function* () {
	const typed = yield* ask(
		Prompt.String({
			message:
				"Please enter a summary for this change (this will be in the changelogs). (submit nothing to open an external editor)",
		}),
	)
	if (typed.length > 0) return typed
	const edited = yield* summaryFromEditor
	if (edited.length > 0) return edited
	return yield* ask(
		Prompt.String({
			message: "Did not find a summary in the edited file. Please enter one:",
			validate: (value) =>
				value.length === 0 ? Effect.fail("Can't be empty.") : Effect.succeed(value),
		}),
	)
})

const confirmMajor = (pkg: Package) =>
	pkg.packageJson.version !== undefined && lessThan(pkg.packageJson.version, "1.0.0")
		? ask(
				Prompt.Confirm({
					message: `The major version of ${pkg.packageJson.name} will be its first major release (1.0.0). Are you sure you want to release the first major version of ${pkg.packageJson.name}?`,
					initial: true,
				}),
			)
		: Effect.succeed(true)

const releasesFromFlags = (options: AddOptions, packages: ReadonlyArray<Package>) => {
	const names = new Set(packages.map((pkg) => pkg.packageJson.name))
	// `--patch a,a` names `a` once; a duplicate key would make the changeset unreadable.
	const byType: ReadonlyArray<readonly [BumpType, ReadonlyArray<string>]> = [
		["major", [...new Set(options.major)]],
		["minor", [...new Set(options.minor)]],
		["patch", [...new Set(options.patch)]],
	]
	const unknown = byType.flatMap(([type, list]) =>
		list
			.filter((name) => !names.has(name))
			.map(
				(name) =>
					`The package ${name} is passed to the \`--${type}\` option but it is not found in the project. You may have misspelled the package name.`,
			),
	)
	const duplicated = [...names].flatMap((name) => {
		const flags = byType.filter(([, list]) => list.includes(name)).map(([type]) => `\`--${type}\``)
		return flags.length > 1
			? [
					`The package ${name} is passed to multiple release type options: ${flags.join(", ")}. Please select only one release type for this package.`,
				]
			: []
	})
	const problems = [...unknown, ...duplicated]
	return problems.length > 0
		? Effect.fail(new CommandExit({ code: 1, message: problems.join("\n") }))
		: Effect.succeed(byType.flatMap(([type, list]) => list.map((name): Release => ({ name, type }))))
}

const pickReleases = Effect.fn("pickReleases")(function* (
	changed: ReadonlyArray<string>,
	packages: ReadonlyArray<Package>,
) {
	const byName = new Map(packages.map((pkg) => [pkg.packageJson.name, pkg]))
	const label = (name: string) => `${name}@${byName.get(name)?.packageJson.version ?? ""}`
	const [only, ...others] = packages
	if (only !== undefined && others.length === 0) {
		const pkg = only
		const type = yield* ask(
			Prompt.Select({
				message: `What kind of change is this for ${pkg.packageJson.name}? (current version is ${pkg.packageJson.version})`,
				choices: [
					{ title: "patch", value: "patch" as const },
					{ title: "minor", value: "minor" as const },
					{ title: "major", value: "major" as const },
				],
			}),
		)
		if (type === "major" && !(yield* confirmMajor(pkg)))
			return yield* new CommandExit({ code: 1, message: "Aborted." })
		return [{ name: pkg.packageJson.name, type }] satisfies ReadonlyArray<Release>
	}
	const sorted = packages.toSorted((a, b) => a.packageJson.name.localeCompare(b.packageJson.name))
	const ordered = [
		...sorted.filter((pkg) => changed.includes(pkg.packageJson.name)),
		...sorted.filter((pkg) => !changed.includes(pkg.packageJson.name)),
	]
	const selected = yield* ask(
		Prompt.MultiSelect({
			message: "Which packages were affected by the changes you made?",
			min: 1,
			choices: ordered.map((pkg) => ({
				title: pkg.packageJson.name + (pkg.packageJson.private === true ? " (private)" : ""),
				value: pkg.packageJson.name,
				description: changed.includes(pkg.packageJson.name) ? "changed" : undefined,
			})),
		}),
	)
	const chosen = selected.toSorted((a, b) => a.localeCompare(b))
	const majorPicked = yield* ask(
		Prompt.MultiSelect({
			message: "Which packages should have a major (X.0.0) bump?",
			choices: chosen.map((name) => ({ title: label(name), value: name })),
		}),
	)
	const majors = yield* Effect.filter(majorPicked, (name) => {
		const pkg = byName.get(name)
		return pkg === undefined ? Effect.succeed(false) : confirmMajor(pkg)
	})
	const afterMajor = chosen.filter((name) => !majors.includes(name))
	const minors =
		afterMajor.length === 0
			? []
			: yield* ask(
					Prompt.MultiSelect({
						message: "Which packages should have a minor (0.X.0) bump?",
						choices: afterMajor.map((name) => ({ title: label(name), value: name })),
					}),
				)
	const patches = afterMajor.filter((name) => !minors.includes(name))
	if (patches.length > 0)
		yield* success(
			`The following packages will be patch (0.0.X) bumped:\n${patches.map(label).join(", ")}`,
		)
	return [
		...majors.map((name): Release => ({ name, type: "major" })),
		...minors.map((name): Release => ({ name, type: "minor" })),
		...patches.map((name): Release => ({ name, type: "patch" })),
	]
})

const changedNames = (changesets: Changesets["Service"], project: Project, since: Option.Option<string>) =>
	changesets.changedPackages(project, Option.getOrUndefined(since)).pipe(
		Effect.map((packages) => packages.map((pkg) => pkg.packageJson.name)),
		Effect.catch((error) =>
			Effect.as(
				warn(
					`Failed to identify which packages have changed since the ${Option.isSome(since) ? "ref" : "base branch"} due to an error:\n${error.message}`,
				),
				[],
			),
		),
	)

const add = Effect.fn("add")(function* (options: AddOptions) {
	const changesets = yield* Changesets
	const project = yield* changesets.load(yield* cwd)
	// Refuse before any prompt: `version` could never consume a changeset added in pre mode.
	yield* changesets.refuseUnsupported(project)
	const versionable = project.packages.packages.filter(
		(pkg) => !shouldSkipPackage(pkg, skipOptions(project.config)),
	)
	if (project.packages.packages.length === 0 || versionable.length === 0) {
		return yield* new CommandExit({
			code: 1,
			message:
				"No versionable packages found\n  Ensure the packages to version are not ignored by the config\n  Ensure that relevant package.json files have a `version` field",
		})
	}
	const fromFlags = options.major.length + options.minor.length + options.patch.length > 0
	const releases = options.empty
		? []
		: fromFlags
			? yield* releasesFromFlags(options, versionable)
			: yield* pickReleases(yield* changedNames(changesets, project, options.since), versionable)
	const summary = Option.isSome(options.message)
		? options.message.value
		: options.empty
			? ""
			: yield* askSummary
	if (!options.empty) {
		const summaryLines = (["major", "minor", "patch"] as const).flatMap((type) => {
			const names = releases.filter((r) => r.type === type).map((r) => r.name)
			return names.length > 0 ? [`${type}:  ${names.join(", ")}`] : []
		})
		yield* success(["Summary of changesets:", ...summaryLines].join("\n"))
	}
	const { file } = yield* changesets.writeChangeset(project, { releases, summary })
	const path = yield* Path.Path
	const relative = path.relative(yield* cwd, file)
	if (releases.some((r) => r.type === "major")) {
		yield* warn(
			"This Changeset includes a major change and we STRONGLY recommend adding more information to the changeset:\n  WHAT the breaking change is\n  WHY the change was made\n  HOW a consumer should update their code",
		)
	}
	yield* success(`${options.empty ? "Empty " : ""}Changeset added - you can now commit it!\n${relative}`)
	if (options.open) yield* openInEditor(relative)
})

const printStatus = (releases: ReadonlyArray<ComprehensiveRelease>, verbose: boolean) => {
	const sorted = releases.toSorted((a, b) => a.name.localeCompare(b.name))
	const groups = (["major", "minor", "patch"] as const).flatMap((type) => {
		const group = sorted.filter((r) => r.type === type)
		if (group.length === 0) return []
		return [
			`- ${type}`,
			...group.flatMap((r) => [
				`  - ${r.name}${verbose ? ` -> ${r.newVersion}` : ""}`,
				...(verbose ? r.changesets.map((id) => `    - .changeset/${id}.md`) : []),
			]),
		]
	})
	return Console.log(`🦋  info Packages to be bumped:\n${groups.join("\n")}`.trim())
}

const unsupported = (name: string) =>
	Command.make(name, {}, () =>
		Effect.fail(
			new UnsupportedFeatureError({
				feature: name,
				message: `\`changeset ${name}\` is not part of this changesets implementation. Only add, version and status are.`,
			}),
		),
	).pipe(Command.withDescription(`Not supported (use @changesets/cli for ${name})`))

const addCommand = Command.make("add", addFlags, add).pipe(
	Command.withDescription("Add a new changeset (default)"),
)

const versionCommand = Command.make(
	"version",
	{
		ignore: listFlag("ignore", "Packages to ignore"),
		snapshot: Flag.String("snapshot").pipe(Flag.withDescription("Not supported"), Flag.optional),
	},
	(options) =>
		Effect.gen(function* () {
			if (Option.isSome(options.snapshot)) {
				return yield* new UnsupportedFeatureError({
					feature: "snapshot",
					message: "Snapshot releases are not supported.",
				})
			}
			const changesets = yield* Changesets
			yield* changesets.version({ cwd: yield* cwd, ignore: options.ignore })
			yield* success("All files have been updated. Review them and commit at your leisure")
		}),
).pipe(Command.withDescription("Version packages and create changelogs"))

const statusCommand = Command.make(
	"status",
	{
		since: Flag.String("since").pipe(
			Flag.withDescription("Show changesets since the provided git ref"),
			Flag.optional,
		),
		verbose: Flag.Boolean("verbose").pipe(
			Flag.withAlias("v"),
			Flag.withDescription("Show more information about the changesets"),
			Flag.withDefault(false),
		),
		output: Flag.String("output").pipe(
			Flag.withAlias("o"),
			Flag.withDescription("Output the status as JSON to a file"),
			Flag.withFallbackConfig(Config.String("CHANGESETS_OUTPUT")),
			Flag.optional,
		),
	},
	(options) =>
		Effect.gen(function* () {
			const changesets = yield* Changesets
			const plan = yield* changesets.status({
				cwd: yield* cwd,
				since: Option.getOrUndefined(options.since),
				output: Option.getOrUndefined(options.output),
			})
			if (Option.isNone(options.output)) yield* printStatus(plan.releases, options.verbose)
		}),
).pipe(Command.withDescription("Show the changesets that currently exist"))

export const changesetCommand = Command.make("changeset", addFlags, add).pipe(
	Command.withDescription("Manage versioning and changelogs with changesets"),
	Command.withSubcommands([
		addCommand,
		versionCommand,
		statusCommand,
		...["init", "publish", "publish-plan", "pack", "pre", "git-tag", "tag"].map(unsupported),
	]),
)

const ownError = (error: unknown): error is { readonly _tag: string; readonly message: string } =>
	Predicate.hasProperty(error, "_tag") &&
	typeof error._tag === "string" &&
	(error._tag.startsWith("@maple/changesets/") || error._tag === "PlatformError") &&
	Predicate.hasProperty(error, "message") &&
	typeof error.message === "string"

/** Runs the CLI; expected failures print their message once and exit non-zero. */
export const main = Command.run(changesetCommand, { version }).pipe(
	Effect.catch((error) => {
		if (!ownError(error)) return Effect.fail(error)
		if (error._tag === "@maple/changesets/CommandExit" && error.message.startsWith("Canceled")) {
			return Console.log(error.message)
		}
		return Effect.andThen(
			Console.error(`🦋  error ${error.message.split("\n").join("\n🦋  error ")}`),
			Effect.fail(error),
		)
	}),
)
