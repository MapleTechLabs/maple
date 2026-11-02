/**
 * `@changesets/format`: with `format: "auto"`, changesets formats the CHANGELOG.md files it
 * wrote (and new changeset files) with the project's formatter, run through the package manager.
 * Detection walks up from the root: config files first, then an installed formatter package.
 */
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Config, FormatterName } from "./config.ts"
import { FormatterError } from "./errors.ts"

type ConfigFile = string | { readonly file: string; readonly key: string }

interface FormatterSpec {
	readonly packageName: string | undefined
	readonly configFiles: ReadonlyArray<ConfigFile>
	readonly args: (files: ReadonlyArray<string>) => ReadonlyArray<string>
}

const prettierConfigs = ["json", "yml", "yaml", "json5", "js", "ts", "mjs", "mts", "cjs", "cts", "toml"]

const formatters = {
	dprint: {
		packageName: "dprint",
		configFiles: ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"],
		args: (files: ReadonlyArray<string>) => ["dprint", "fmt", "--allow-no-files", ...files],
	},
	deno: {
		packageName: undefined,
		configFiles: ["deno.json", "deno.jsonc", { file: "deno.json", key: "fmt" }],
		args: (files: ReadonlyArray<string>) => ["fmt", "--permit-no-files", ...files],
	},
	oxfmt: {
		packageName: "oxfmt",
		configFiles: [".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.ts", "oxfmt.config.mts"],
		args: (files: ReadonlyArray<string>) => [
			"oxfmt",
			"--write",
			"--no-error-on-unmatched-pattern",
			...files,
		],
	},
	prettier: {
		packageName: "prettier",
		configFiles: [
			".prettierrc",
			...prettierConfigs.map((ext) => `.prettierrc.${ext}`),
			...["js", "ts", "mjs", "mts", "cjs", "cts"].map((ext) => `prettier.config.${ext}`),
			{ file: "package.json", key: "prettier" },
		],
		args: (files: ReadonlyArray<string>) => [
			"prettier",
			"--write",
			"--no-error-on-unmatched-pattern",
			...files,
		],
	},
} satisfies Record<FormatterName, FormatterSpec>

// `format: "auto"` skips biome, like `@changesets/write` and `apply-release-plan` do.
const detectOrder: ReadonlyArray<FormatterName> = ["dprint", "deno", "oxfmt", "prettier"]

const locks: ReadonlyArray<readonly [string, Agent]> = [
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
	["deno.lock", "deno"],
	["pnpm-lock.yaml", "pnpm"],
	["pnpm-workspace.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["package-lock.json", "npm"],
	["npm-shrinkwrap.json", "npm"],
]

type Agent = "bun" | "deno" | "pnpm" | "yarn" | "npm"

// `package-manager-detector`'s `execute-local` command per agent.
const executeLocal = (
	agent: Agent,
	args: ReadonlyArray<string>,
): readonly [string, ReadonlyArray<string>] => {
	switch (agent) {
		case "bun":
			return ["bun", ["x", ...args]]
		case "pnpm":
			return ["pnpm", ["exec", ...args]]
		case "yarn":
			return ["yarn", ["exec", ...args]]
		case "deno":
			return ["deno", ["task", "--eval", ...args]]
		case "npm":
			return ["npx", args]
	}
}

const PackageManagerField = Schema.Struct({ packageManager: Schema.optionalKey(Schema.String) })
const decodeKeys = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)
const decodePackageManager = Schema.decodeUnknownOption(Schema.fromJsonString(PackageManagerField))

export interface FormatterApi {
	/** The formatter `config.format` resolves to for this root, if any. */
	readonly detect: (
		format: Config["format"],
		rootDir: string,
	) => Effect.Effect<Option.Option<FormatterName>>
	/** Formats `files` in place; a formatter that exits non-zero fails, as in changesets. */
	readonly format: (
		format: Config["format"],
		rootDir: string,
		files: ReadonlyArray<string>,
	) => Effect.Effect<void, FormatterError>
}

export class Formatter extends Context.Service<Formatter, FormatterApi>()("@maple/changesets/Formatter", {
	make: Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

		const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false))
		const readText = (file: string) => fs.readFileString(file).pipe(Effect.option)

		const ancestors = (dir: string): ReadonlyArray<string> => {
			const parent = path.dirname(dir)
			return parent === dir ? [dir] : [dir, ...ancestors(parent)]
		}

		const firstSome = <I, A>(
			items: ReadonlyArray<I>,
			f: (item: I) => Effect.Effect<Option.Option<A>>,
		): Effect.Effect<Option.Option<A>> => {
			const [head, ...rest] = items
			if (head === undefined) return Effect.succeed(Option.none())
			return Effect.flatMap(f(head), (found) =>
				Option.isSome(found) ? Effect.succeed(found) : firstSome(rest, f),
			)
		}

		const hasConfig = (dir: string, configFile: ConfigFile) =>
			typeof configFile === "string"
				? exists(path.join(dir, configFile))
				: Effect.map(readText(path.join(dir, configFile.file)), (text) =>
						Option.isSome(
							Option.flatMap(text, decodeKeys).pipe(
								Option.filter((keys) => configFile.key in keys),
							),
						),
					)

		const byConfig = (dir: string) =>
			firstSome(detectOrder, (name) =>
				Effect.map(
					Effect.forEach(formatters[name].configFiles, (configFile) => hasConfig(dir, configFile)),
					(found) => (found.some(Boolean) ? Option.some(name) : Option.none()),
				),
			)

		const byPackage = (dir: string) =>
			firstSome(detectOrder, (name) => {
				const packageName = formatters[name].packageName
				return packageName === undefined
					? Effect.succeed(Option.none())
					: Effect.map(exists(path.join(dir, "node_modules", packageName)), (found) =>
							found ? Option.some(name) : Option.none(),
						)
			})

		const detect = Effect.fn("Formatter.detect")(function* (format: Config["format"], rootDir: string) {
			if (format === false) return Option.none<FormatterName>()
			if (format !== "auto") return Option.some(format)
			const dirs = ancestors(path.resolve(rootDir))
			const configured = yield* firstSome(dirs, byConfig)
			return Option.isSome(configured) ? configured : yield* firstSome(dirs, byPackage)
		})

		const packageManagerIn = (dir: string) =>
			Effect.map(readText(path.join(dir, "package.json")), (text) =>
				Option.flatMap(Option.flatMap(text, decodePackageManager), (json) =>
					Option.fromNullishOr(json.packageManager?.split("@")[0]).pipe(
						Option.filter((agent): agent is Agent =>
							["bun", "deno", "pnpm", "yarn", "npm"].includes(agent),
						),
					),
				),
			)

		const agentFor = (rootDir: string) =>
			Effect.map(
				firstSome(ancestors(path.resolve(rootDir)), (dir) =>
					Effect.gen(function* () {
						const lock = yield* firstSome(
							locks.map(([file]) => file),
							(file) =>
								Effect.map(exists(path.join(dir, file)), (found) =>
									found ? Option.some(file) : Option.none(),
								),
						)
						const declared = yield* packageManagerIn(dir)
						if (Option.isSome(lock)) {
							const fromLock = locks.find(([file]) => file === lock.value)?.[1] ?? "npm"
							return Option.some(Option.getOrElse(declared, () => fromLock))
						}
						return declared
					}),
				),
				Option.getOrElse((): Agent => "npm"),
			)

		const format = Effect.fn("Formatter.format")(function* (
			config: Config["format"],
			rootDir: string,
			files: ReadonlyArray<string>,
		) {
			const name = yield* detect(config, rootDir)
			if (Option.isNone(name) || files.length === 0) return
			const spec = formatters[name.value]
			const [command, args] =
				name.value === "deno"
					? (["deno", spec.args(files)] as const)
					: executeLocal(yield* agentFor(rootDir), spec.args(files))
			const result = yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* spawner.spawn(
						ChildProcess.make(command, [...args], { cwd: rootDir }),
					)
					const [, stderr, exitCode] = yield* Effect.all(
						[
							Stream.runDrain(handle.stdout),
							Stream.mkString(Stream.decodeText(handle.stderr)),
							handle.exitCode,
						],
						{ concurrency: "unbounded" },
					)
					return { stderr, exitCode: Number(exitCode) }
				}),
			).pipe(
				Effect.mapError(
					(cause) =>
						new FormatterError({
							message: `Could not run ${command}: ${cause.message}`,
							formatter: name.value,
							stderr: "",
						}),
				),
			)
			if (result.exitCode !== 0) {
				return yield* new FormatterError({
					message: `${[command, ...args.slice(0, 2)].join(" ")} exited with code ${result.exitCode}`,
					formatter: name.value,
					stderr: result.stderr,
				})
			}
		})

		return { detect, format } satisfies FormatterApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
