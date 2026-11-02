/** The `changeset` bin as the root scripts run it: a subprocess in a fixture checkout. */
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path } from "effect"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { run, setupFixture, snapshotTree } from "./testing/fixtures.ts"

const bin = join(import.meta.dirname, "bin.ts")
const fixturesDir = join(import.meta.dirname, "__fixtures__")

/** Runs `changeset <args>` in a fresh copy of `fixture`; returns its output and new or removed files. */
const changeset = (
	fixture: string,
	args: ReadonlyArray<string>,
	extra: Readonly<Record<string, string>> = {},
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const dir = yield* fs.makeTempDirectoryScoped()
			yield* setupFixture(path.join(fixturesDir, fixture), dir)
			yield* Effect.forEach(Object.entries(extra), ([file, contents]) =>
				fs.writeFileString(path.join(dir, file), contents),
			)
			const before = yield* snapshotTree(dir)
			const result = yield* run("bun", [bin, ...args], dir)
			const after = yield* snapshotTree(dir)
			const added = [...after].filter(([file]) => !before.has(file))
			return { ...result, added, removed: [...before.keys()].filter((file) => !after.has(file)) }
		}),
	).pipe(Effect.provide(NodeServices.layer), Effect.runPromise)

describe("changeset add", () => {
	test("writes the releases from --major/--minor/--patch and the -m summary", async () => {
		const result = await changeset("basic", [
			"--patch",
			"alpha",
			"--minor",
			"beta,gamma",
			"-m",
			"Hello there",
		])
		expect(result.exitCode).toBe(0)
		expect(result.added).toHaveLength(1)
		const [[file, contents]] = result.added as [[string, string]]
		expect(file).toMatch(/^\.changeset\/[a-z]+-[a-z]+-[a-z]+\.md$/)
		expect(contents).toBe('---\n"beta": minor\n"gamma": minor\n"alpha": patch\n---\n\nHello there\n')
	})

	test("the explicit add subcommand takes the same flags", async () => {
		const result = await changeset("basic", ["add", "--major", "beta", "--message", "Breaking"])
		expect(result.added.map(([, contents]) => contents)).toEqual([
			'---\n"beta": major\n---\n\nBreaking\n',
		])
	})

	test("--empty writes a changeset without releases", async () => {
		const result = await changeset("basic", ["--empty"])
		expect(result.exitCode).toBe(0)
		expect(result.added.map(([, contents]) => contents)).toEqual(["---\n\n---\n\n\n"])
	})

	test("names a package repeated within one flag once", async () => {
		const result = await changeset("basic", ["--patch", "alpha,alpha", "--patch", "alpha", "-m", "Once"])
		expect(result.added.map(([, contents]) => contents)).toEqual(['---\n"alpha": patch\n---\n\nOnce\n'])
	})

	test("refuses pre mode before writing anything", async () => {
		const result = await changeset("basic", ["--patch", "alpha", "-m", "x"], {
			".changeset/pre.json":
				'{ "mode": "pre", "tag": "next", "initialVersions": {}, "changesets": [] }\n',
		})
		expect(result.exitCode).toBe(1)
		expect(result.added).toEqual([])
		expect(result.stderr).toContain("Pre mode (.changeset/pre.json) is not supported")
	})

	test("rejects unknown packages and conflicting bump flags without writing", async () => {
		const result = await changeset("basic", ["--patch", "alpha,nope", "--minor", "alpha", "-m", "x"])
		expect(result.exitCode).toBe(1)
		expect(result.added).toEqual([])
		expect(result.stderr).toContain(
			"The package nope is passed to the `--patch` option but it is not found",
		)
		expect(result.stderr).toContain(
			"The package alpha is passed to multiple release type options: `--minor`, `--patch`",
		)
	})
})

describe("changeset version and status", () => {
	test("version applies the changesets and exits 0", async () => {
		const result = await changeset("changelog-false", ["version"])
		expect(result.exitCode).toBe(0)
		expect(result.removed).toEqual([".changeset/a-major.md"])
		expect(result.stdout).toContain("All files have been updated")
	})

	test("version exits 1 when there are no changesets", async () => {
		const result = await changeset("no-changesets", ["version"])
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("No unreleased changesets found.")
	})

	test("status exits 1 when a package changed without a changeset", async () => {
		const result = await changeset("no-changesets", ["status"])
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("Some packages have been changed but no changesets were found.")
	})

	test("status --verbose lists the bumps with their changesets", async () => {
		const result = await changeset("changelog-false", ["status", "--verbose"])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe(
			"🦋  info Packages to be bumped:\n- major\n  - a -> 2.0.0\n    - .changeset/a-major.md\n- patch\n  - b -> 1.0.1\n",
		)
	})

	test("refuses the commands it does not implement", async () => {
		const result = await changeset("basic", ["publish"])
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("`changeset publish` is not part of this changesets implementation")
	})
})
