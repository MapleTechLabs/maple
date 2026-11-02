/**
 * `parseChangesetFile` against `@changesets/parse` on the corpus in `frontmatter-cases.json`
 * (recorded by `scripts/record-reference.ts`): same changeset, or the same first error line.
 */
import { Result, Schema } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { parseChangesetFile } from "./frontmatter.ts"

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
