/**
 * `parseChangesetFile` against `@changesets/parse` on the corpus in `frontmatter-cases.json`
 * (recorded by `scripts/record-reference.ts`): same changeset, or the same first error line.
 */
import { Result, Schema } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { parseChangesetFile, splitFrontmatter } from "./frontmatter.ts"

const Case = Schema.Union([
	Schema.Struct({
		input: Schema.String,
		changeset: Schema.Struct({
			releases: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String })),
			summary: Schema.String,
		}),
	}),
	Schema.Struct({ input: Schema.String, error: Schema.String }),
])

const cases = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Case)))(
	readFileSync(join(import.meta.dirname, "__fixtures__", "frontmatter-expected.json"), "utf8"),
)

describe("parseChangesetFile matches @changesets/parse", () => {
	test.each(cases.map((c) => [JSON.stringify(c.input).slice(0, 60), c] as const))("%s", (_, expected) => {
		const parsed = parseChangesetFile(expected.input)
		if ("changeset" in expected) {
			expect(parsed).toEqual(Result.succeed(expected.changeset))
		} else {
			expect(Result.isFailure(parsed) ? parsed.failure.split("\n")[0] : parsed).toBe(expected.error)
		}
	})
})

describe("splitFrontmatter", () => {
	// The pattern @changesets/parse uses; the linear scan must capture exactly what it captures.
	const reference = /\s*---([^]*?)\r?\n\s*---(\s*(?:\n|$)[^]*)/
	const alphabet = ["-", "-", "-", "\n", "\n", "\r", " ", "\t", " ", "a", '"a": patch']

	// mulberry32, seeded: 32-bit integer math keeps the corpus identical and well spread across runs.
	const random = (seed: number) => {
		const t = Math.imul(seed ^ (seed >>> 15), seed | 1)
		const mixed = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))
		return (mixed ^ (mixed >>> 14)) >>> 0
	}
	const inputs = Array.from({ length: 20_000 }, (_, i) =>
		Array.from(
			{ length: random(i * 7919 + 1) % 24 },
			(_, j) => alphabet[random(i * 104_729 + j + 2) % alphabet.length],
		).join(""),
	)

	test("captures the same frontmatter and summary as the changesets regex", () => {
		const mismatches = inputs.filter((input) => {
			const expected = reference.exec(input)
			const actual = splitFrontmatter(input)
			return expected === null
				? actual !== undefined
				: actual?.releases !== expected[1] || actual.summary !== expected[2]
		})
		expect(mismatches).toEqual([])
	})
})
