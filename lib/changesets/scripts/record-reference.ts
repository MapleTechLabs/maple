/**
 * Records what the real `@changesets/cli` does to each fixture into `expected.json`, which the
 * differential test then holds this implementation to. The reference CLI is not a dependency:
 *
 *   CHANGESETS_CLI=/path/to/@changesets/cli/bin.js bun run record-reference
 *
 * e.g. after `bun add --cwd /tmp/ref @changesets/cli@3.0.3`. It runs under Node, as in CI.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Effect, FileSystem, Path, Result } from "effect"
import { createRequire } from "node:module"
import {
	diffTrees,
	type Expected,
	FixtureError,
	run,
	setupFixture,
	snapshotTree,
} from "../src/testing/fixtures.ts"
import type { Changeset } from "../src/types.ts"

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const cli = yield* Config.String("CHANGESETS_CLI")
	const reported = yield* run("node", [cli, "--version"], path.dirname(cli))
	if (reported.stdout.trim() !== "3.0.3") {
		return yield* new FixtureError({
			message: `expected @changesets/cli 3.0.3, got ${reported.stdout.trim()}`,
		})
	}
	const fixturesDir = path.resolve(import.meta.dirname, "../src/__fixtures__")
	const fixtures = (yield* fs.readDirectory(fixturesDir)).toSorted()
	yield* Effect.forEach(fixtures, (name) =>
		Effect.scoped(
			Effect.gen(function* () {
				const fixtureDir = path.join(fixturesDir, name)
				if ((yield* fs.stat(fixtureDir)).type !== "Directory") return
				const versionDir = yield* fs.makeTempDirectoryScoped()
				yield* setupFixture(fixtureDir, versionDir)
				const before = yield* snapshotTree(versionDir)
				const versioned = yield* run("node", [cli, "version"], versionDir)
				const version = diffTrees(before, yield* snapshotTree(versionDir), versioned.exitCode)

				const statusDir = yield* fs.makeTempDirectoryScoped()
				const outDir = yield* fs.makeTempDirectoryScoped()
				yield* setupFixture(fixtureDir, statusDir)
				const outFile = path.join(outDir, "status.json")
				const statused = yield* run("node", [cli, "status", "--output", outFile], statusDir)
				const output = (yield* fs.exists(outFile)) ? yield* fs.readFileString(outFile) : null

				const expected: Expected = { version, status: { exitCode: statused.exitCode, output } }
				yield* fs.writeFileString(
					path.join(fixtureDir, "expected.json"),
					JSON.stringify(expected, null, "\t") + "\n",
				)
				yield* Console.log(
					`${name}: version exit ${version.exitCode}, ${Object.keys(version.changed).length} changed, ${version.deleted.length} deleted; status exit ${statused.exitCode}`,
				)
			}),
		),
	)
	// `@changesets/parse` sits behind `@changesets/read` in the reference CLI's dependency tree.
	const read = createRequire(yield* fs.realPath(cli)).resolve("@changesets/read")
	const parse: { readonly parseChangesetFile: (contents: string) => Changeset } = yield* Effect.promise(
		() => import(createRequire(read).resolve("@changesets/parse")),
	)
	const cases: ReadonlyArray<string> = JSON.parse(
		yield* fs.readFileString(path.join(fixturesDir, "frontmatter-cases.json")),
	)
	const results = cases.map((input) =>
		Result.match(
			Result.try({ try: () => parse.parseChangesetFile(input), catch: (error) => String(error) }),
			{
				onSuccess: (changeset) => ({ input, changeset }),
				onFailure: (error) => ({ input, error: error.replace(/^Error: /, "").split("\n")[0] }),
			},
		),
	)
	yield* fs.writeFileString(
		path.join(fixturesDir, "frontmatter-expected.json"),
		JSON.stringify(results, null, "\t") + "\n",
	)
	yield* Console.log(`frontmatter: ${results.length} cases`)
})

// Script entry point: the one place the platform layer is provided.
// oxlint-disable-next-line effecttsgo/strict-effect-provide
program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
