// BOUNDARY: explicitly selected local modules execute trusted code; their exports are decoded here.
import { Effect, MutableRef, Result, Schema } from "effect"
import { realpath, stat } from "node:fs/promises"
import { extname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { ProjectorRegistry, type ProjectorModule, type RegisterProjector } from "@maple/eventing-core"

export class ProjectorModuleError extends Schema.TaggedError<ProjectorModuleError>()(
	"@maple/cli/ProjectorModuleError",
	{ path: Schema.String, message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const ModuleExport = Schema.Struct({
	apiVersion: Schema.Literal(1),
	register: Schema.declare<ProjectorModule["register"]>(
		(value): value is ProjectorModule["register"] => typeof value === "function",
	),
})

const ModuleNamespace = Schema.Struct({ default: ModuleExport })

const error = (path: string, detail: string, cause?: unknown): ProjectorModuleError =>
	new ProjectorModuleError({ path, message: `projector module ${path}: ${detail}`, cause })

/** Explicit filesystem paths only: no package lookup, URL loading or automatic discovery. */
export const resolveProjectorModulePaths = (
	paths: readonly string[],
): Effect.Effect<readonly string[], ProjectorModuleError> =>
	Effect.forEach(paths, (path) =>
		Effect.gen(function* () {
			if (path.trim() === "" || /^[a-z][a-z0-9+.-]*:/i.test(path))
				return yield* error(path, "expected a local .mjs file path")
			const absolute = resolve(path)
			if (extname(absolute) !== ".mjs") return yield* error(path, "expected a bundled .mjs file")
			const canonical = yield* Effect.tryPromise({
				try: () => realpath(absolute),
				catch: (cause) => error(path, "cannot resolve file", cause),
			})
			if (extname(canonical) !== ".mjs")
				return yield* error(path, "resolved file must have .mjs extension")
			const info = yield* Effect.tryPromise({
				try: () => stat(canonical),
				catch: (cause) => error(path, "cannot inspect file", cause),
			})
			if (!info.isFile()) return yield* error(path, "expected a regular file")
			return canonical
		}),
	)

const registerModule = (registry: ProjectorRegistry, path: string) =>
	Effect.gen(function* () {
		const namespace: unknown = yield* Effect.tryPromise({
			try: () => import(pathToFileURL(path).href),
			catch: (cause) => error(path, "import failed", cause),
		})
		const module = yield* Schema.decodeUnknownEffect(ModuleNamespace)(namespace).pipe(
			Effect.mapError((cause) =>
				error(path, "expected default export { apiVersion: 1, register }", cause),
			),
		)
		const failures: ProjectorModuleError[] = []
		// Retained callbacks cannot modify the registry after initialization.
		const accepting = MutableRef.make(true)
		const register: RegisterProjector = (projector) => {
			if (!MutableRef.get(accepting)) return
			const result = Result.try({
				try: () => {
					if (
						typeof projector?.decodeConfig !== "function" ||
						typeof projector?.decodeOutput !== "function" ||
						typeof projector?.project !== "function"
					)
						return Result.fail(
							error(
								path,
								"projector requires decodeConfig, decodeOutput and project functions",
							),
						)
					return registry
						.register(projector)
						.pipe(Result.mapError((cause) => error(path, cause.message, cause)))
				},
				catch: (cause) => error(path, "invalid projector registration", cause),
			}).pipe(Result.flatMap((result) => result))
			if (Result.isFailure(result)) failures.push(result.failure)
		}
		yield* Effect.tryPromise({
			try: async () => module.default.register(register),
			catch: (cause) => error(path, "registration failed", cause),
		}).pipe(Effect.ensuring(Effect.sync(() => MutableRef.set(accepting, false))))
		if (failures[0] !== undefined) return yield* failures[0]
	})

/**
 * Each startup gets a fresh registry. No extension can replace an existing
 * id/version, and a failed registration refuses the whole startup even if the
 * module ignores it. Modules are trusted code, not a sandbox or a hot-reload API.
 */
export const loadProjectorModules = (
	paths: readonly string[],
): Effect.Effect<ProjectorRegistry, ProjectorModuleError> =>
	Effect.gen(function* () {
		const resolved = yield* resolveProjectorModulePaths(paths)
		const duplicate = resolved.find((path, index) => resolved.indexOf(path) !== index)
		if (duplicate !== undefined) return yield* error(duplicate, "file selected more than once")
		const registry = new ProjectorRegistry()
		yield* Effect.forEach(resolved, (path) => registerModule(registry, path), { discard: true })
		return registry
	})
