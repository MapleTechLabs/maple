import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import { describe, expect, test } from "vitest"
import type { Config } from "./config.ts"
import { Formatter } from "./formatter.ts"

const layer = Formatter.layer.pipe(Layer.provideMerge(NodeServices.layer))

/** Detects the formatter for a temp root holding `files`, optionally from a nested `cwd`. */
const detect = (files: Readonly<Record<string, string>>, format: Config["format"] = "auto", cwd = ".") =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const formatter = yield* Formatter
			const root = yield* fs.makeTempDirectoryScoped()
			yield* Effect.forEach(Object.entries(files), ([file, contents]) =>
				Effect.andThen(
					fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true }),
					() => fs.writeFileString(path.join(root, file), contents),
				),
			)
			return Option.getOrNull(yield* formatter.detect(format, path.join(root, cwd)))
		}),
	).pipe(Effect.provide(layer), Effect.runPromise)

describe("Formatter.detect", () => {
	test("finds the formatter from its config file", async () => {
		expect(await detect({ ".oxfmtrc.json": "{}" })).toBe("oxfmt")
		expect(await detect({ ".prettierrc": "{}" })).toBe("prettier")
		expect(await detect({ "package.json": '{ "prettier": {} }' })).toBe("prettier")
	})

	test("prefers dprint, deno, oxfmt, prettier in that order and ignores biome", async () => {
		expect(await detect({ ".prettierrc": "{}", ".oxfmtrc.json": "{}", "dprint.json": "{}" })).toBe(
			"dprint",
		)
		expect(await detect({ "biome.json": "{}" })).toBeNull()
	})

	test("walks up from a nested root, and falls back to an installed formatter package", async () => {
		expect(await detect({ ".oxfmtrc.json": "{}", "nested/package.json": "{}" }, "auto", "nested")).toBe(
			"oxfmt",
		)
		expect(await detect({ "node_modules/prettier/package.json": "{}" })).toBe("prettier")
	})

	test("an explicit format wins and false disables formatting", async () => {
		expect(await detect({ ".oxfmtrc.json": "{}" }, "prettier")).toBe("prettier")
		expect(await detect({ ".oxfmtrc.json": "{}" }, false)).toBeNull()
	})
})
