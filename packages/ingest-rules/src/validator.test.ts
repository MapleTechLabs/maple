import { describe, expect, it } from "@effect/vitest"
import { ingestRuleProblems, regexProblem } from "@maple/domain/ingest-rules"
import { Arbitrary, Schema } from "effect"

// The API runs the validator on every rule a customer saves, so it must answer for any text,
// including half-typed escapes and groups. A scanner that stops advancing hangs the request.

const FRAGMENTS = [
	"\\",
	"\\p{",
	"\\u{",
	"\\x",
	"\\b",
	"p",
	"L",
	"{",
	"}",
	"{2,",
	"(",
	"(?:",
	"(?<n>",
	"(?i)",
	")",
	"[",
	"[^",
	"]",
	"?",
	"*",
	"+",
	"|",
	"^",
	"$",
	".",
	"a",
	"4",
	"1",
	",",
	":",
	"<",
	">",
	"=",
	"é",
]

const index = Arbitrary.schema(
	Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: FRAGMENTS.length - 1 })),
)
const regexText = Arbitrary.map(Arbitrary.array(index, { maxLength: 12 }), (picks) =>
	picks.map((pick) => FRAGMENTS[pick]).join(""),
)

describe("the rule validator", () => {
	it.prop(
		"answers for any pattern text",
		[regexText],
		([pattern]) => {
			const problem = regexProblem(pattern)
			expect(problem === null || typeof problem === "string").toBe(true)
			const rule = {
				signals: ["logs" as const],
				conditions: [{ field: "body" as const, op: "regex" as const, value: pattern }],
				action: { _tag: "drop" as const, keepPercent: 0 },
			}
			expect(Array.isArray(ingestRuleProblems(rule))).toBe(true)
		},
		{ arbitrary: { runs: 2000 } },
	)
})
