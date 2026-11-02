/**
 * Differential test: every fixture's `expected.json` is what `@changesets/cli` 3.0.3 wrote
 * (`scripts/record-reference.ts`). This implementation must produce the same files, byte for
 * byte, the same `status --output` JSON and the same exit codes.
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { Changesets } from "./changesets.ts"
import { diffTrees, Expected, setupFixture, snapshotTree } from "./testing/fixtures.ts"

const fixturesDir = join(import.meta.dirname, "__fixtures__")
const fixtures = readdirSync(fixturesDir, { withFileTypes: true }).flatMap((entry) =>
	entry.isDirectory() ? [entry.name] : [],
)

const layer = Changesets.layer.pipe(Layer.provideMerge(NodeServices.layer))

const exitCodeOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.as(0),
		Effect.catch((error) =>
			error._tag === "@maple/changesets/CommandExit" ? Effect.succeed(1) : Effect.fail(error),
		),
	)

const runFixture = (name: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const changesets = yield* Changesets
			const fixtureDir = path.join(fixturesDir, name)
			const expected = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Expected))(
				yield* fs.readFileString(path.join(fixtureDir, "expected.json")),
			)

			const versionDir = yield* fs.makeTempDirectoryScoped()
			yield* setupFixture(fixtureDir, versionDir)
			const before = yield* snapshotTree(versionDir)
			const versionExit = yield* exitCodeOf(changesets.version({ cwd: versionDir }))
			const version = diffTrees(before, yield* snapshotTree(versionDir), versionExit)

			const statusDir = yield* fs.makeTempDirectoryScoped()
			const outFile = path.join(yield* fs.makeTempDirectoryScoped(), "status.json")
			yield* setupFixture(fixtureDir, statusDir)
			const statusExit = yield* exitCodeOf(changesets.status({ cwd: statusDir, output: outFile }))
			const output = (yield* fs.exists(outFile)) ? yield* fs.readFileString(outFile) : null

			return { expected, actual: { version, status: { exitCode: statusExit, output } } }
		}),
	).pipe(Effect.provide(layer), Effect.runPromise)

describe("matches @changesets/cli 3.0.3", () => {
	test.each(fixtures)("%s", async (name) => {
		const { expected, actual } = await runFixture(name)
		expect(actual.version.exitCode).toBe(expected.version.exitCode)
		expect(actual.version.deleted.toSorted()).toEqual(expected.version.deleted.toSorted())
		expect(actual.version.changed).toEqual(expected.version.changed)
		expect(actual.status).toEqual(expected.status)
	})
})
