/**
 * Workspace discovery as `@manypkg/get-packages` does it for package.json `workspaces` with a
 * bun, yarn or npm lockfile: the nearest such ancestor is the root, else the nearest package.json
 * is a single-package root. Packages are the matching dirs with a package.json, sorted by path.
 */
import { Effect, FileSystem, Option, Path, type PlatformError, Schema } from "effect"
import { WorkspaceError } from "./errors.ts"
import type { Package, PackageJson, Packages } from "./types.ts"

const Ranges = Schema.optionalKey(Schema.Record(Schema.String, Schema.String))

const Manifest = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	version: Schema.optionalKey(Schema.String),
	private: Schema.optionalKey(Schema.Boolean),
	workspaces: Schema.optionalKey(
		Schema.Union([
			Schema.Array(Schema.String),
			Schema.Struct({ packages: Schema.optionalKey(Schema.Array(Schema.String)) }),
		]),
	),
	dependencies: Ranges,
	devDependencies: Ranges,
	peerDependencies: Ranges,
	optionalDependencies: Ranges,
})
type Manifest = typeof Manifest.Type

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))

const isList = (value: unknown): value is ReadonlyArray<string> => Array.isArray(value)

const workspaceGlobs = ({ workspaces }: Manifest): ReadonlyArray<string> | undefined =>
	workspaces === undefined ? undefined : isList(workspaces) ? workspaces : (workspaces.packages ?? [])

const toPackageJson = (manifest: Manifest, name: string): PackageJson => ({ ...manifest, name })

export const readManifest = Effect.fn("readManifest")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const file = path.join(dir, "package.json")
	const text = yield* fs.readFileString(file)
	return yield* decodeManifest(text).pipe(
		Effect.mapError(
			(cause) =>
				new WorkspaceError({
					message: `Could not read ${file}: ${cause.message}`,
					path: file,
					cause,
				}),
		),
	)
})

const manifestIn = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const exists = yield* fs.exists(path.join(dir, "package.json"))
		return exists ? Option.some(yield* readManifest(dir)) : Option.none()
	})

// manypkg's bun and yarn tools take either workspaces form, its npm tool only the array.
const isWorkspaceRoot = (dir: string, manifest: Manifest) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		if (manifest.workspaces === undefined) return false
		const has = (file: string) => fs.exists(path.join(dir, file))
		if ((yield* has("bun.lock")) || (yield* has("bun.lockb")) || (yield* has("yarn.lock"))) return true
		return isList(manifest.workspaces) && (yield* has("package-lock.json"))
	})

interface Root {
	readonly dir: string
	readonly manifest: Manifest
}

// Walks up from `dir`; the first manifest with `workspaces` wins, else the nearest manifest.
const findRoot = (
	dir: string,
	nearest: Option.Option<Root>,
): Effect.Effect<
	Option.Option<Root>,
	WorkspaceError | PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const manifest = yield* manifestIn(dir)
		if (Option.isSome(manifest) && (yield* isWorkspaceRoot(dir, manifest.value))) {
			return Option.some({ dir, manifest: manifest.value })
		}
		const nextNearest =
			Option.isNone(nearest) && Option.isSome(manifest)
				? Option.some({ dir, manifest: manifest.value })
				: nearest
		const parent = path.dirname(dir)
		return parent === dir ? nextNearest : yield* findRoot(parent, nextNearest)
	})

const expandGlobs = Effect.fn("expandGlobs")(function* (globs: ReadonlyArray<string>, rootDir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const exclude = ["**/node_modules", ...globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1))]
	const matched = yield* Effect.forEach(
		globs.filter((g) => !g.startsWith("!")),
		(glob) => fs.glob(glob.replace(/\/+$/, ""), { root: rootDir, exclude }),
	)
	const candidates = [
		...new Set(matched.flat().map((relative) => path.resolve(rootDir, relative))),
	].toSorted()
	const found = yield* Effect.forEach(candidates, (dir) =>
		Effect.gen(function* () {
			const info = yield* fs.stat(dir)
			if (info.type !== "Directory") return Option.none<Root>()
			const manifest = yield* manifestIn(dir)
			return Option.map(manifest, (value): Root => ({ dir, manifest: value }))
		}),
	)
	return found.flatMap(Option.toArray)
})

/** Finds the workspace containing `cwd` and reads every package manifest in it. */
export const getPackages = Effect.fn("getPackages")(function* (cwd: string) {
	const path = yield* Path.Path
	const start = path.resolve(cwd)
	const root = yield* findRoot(start, Option.none())
	if (Option.isNone(root)) {
		return yield* new WorkspaceError({
			message: `No package.json found from ${start} upwards`,
			path: start,
		})
	}
	const rootDir = root.value.dir
	const rootPackage: Package = {
		dir: rootDir,
		relativeDir: ".",
		packageJson: toPackageJson(root.value.manifest, root.value.manifest.name ?? ""),
	}
	const globs = workspaceGlobs(root.value.manifest)
	if (globs === undefined) return { rootDir, rootPackage, packages: [rootPackage] } satisfies Packages
	const found = yield* expandGlobs(globs, rootDir)
	const unnamed = found.filter(({ manifest }) => manifest.name === undefined)
	if (unnamed.length > 0) {
		const files = unnamed
			.map(({ dir }) => path.join(path.relative(rootDir, dir), "package.json"))
			.toSorted()
		return yield* new WorkspaceError({
			message: `The following package.jsons are missing the "name" field:\n${files.join("\n")}`,
			path: rootDir,
		})
	}
	const packages = found.map(({ dir, manifest }) => ({
		dir,
		relativeDir: path.relative(rootDir, dir),
		packageJson: toPackageJson(manifest, manifest.name ?? ""),
	}))
	return { rootDir, rootPackage, packages } satisfies Packages
})
