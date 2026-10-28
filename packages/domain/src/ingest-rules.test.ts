import { describe, expect, it } from "vitest"
import { ingestRuleProblems, regexProblem, type IngestRuleSpec } from "./ingest-rules"

const redact = (
	overrides: Partial<Extract<IngestRuleSpec["action"], { _tag: "redact" }>> = {},
): IngestRuleSpec["action"] => ({
	_tag: "redact",
	keys: [],
	detectors: ["email"],
	patterns: [],
	scopes: ["attributes"],
	method: "mask",
	...overrides,
})

describe("regexProblem", () => {
	it("accepts the subset both engines share", () => {
		expect(regexProblem("^kube-[a-z]+$")).toBeNull()
		expect(regexProblem("(?i)connection reset")).toBeNull()
		expect(regexProblem("(?<id>[0-9]+)")).toBeNull()
		expect(regexProblem("\\++")).toBeNull()
		expect(regexProblem("(ab)+c")).toBeNull()
		expect(regexProblem("(GET|POST) /health")).toBeNull()
	})

	it.each([
		["foo(?=bar)", "lookaround is not supported"],
		["(?<!x)y", "lookaround is not supported"],
		["(a)\\1", "backreferences are not supported"],
		["a++", "possessive quantifiers are not supported"],
		["(?P<x>a)", "use (?<name>...) for named groups"],
		["a(?i)b", "inline flags are only supported as a leading (?i)"],
		["(?s)a.b", "only the (?i) inline flag is supported"],
		["a*", "pattern matches empty text"],
		["(a+)+$", "a repeated group may not contain a repetition or alternation"],
		["(a|aa)+$", "a repeated group may not contain a repetition or alternation"],
		["[a&&b]", "character class set operations are not supported"],
		["[^]x", "use an explicit class or escape instead"],
		["x{1000}", "counted repetitions are limited to 999"],
		["(", "pattern is not a valid regular expression"],
		["", "pattern is empty"],
	])("rejects %s", (pattern, problem) => {
		expect(regexProblem(pattern)).toBe(problem)
	})
})

describe("ingestRuleProblems", () => {
	it("accepts a well-formed drop and redact rule", () => {
		expect(
			ingestRuleProblems({
				signals: ["logs"],
				conditions: [{ field: "severity", op: "lt", value: "info" }],
				action: { _tag: "drop", keepPercent: 0 },
			}),
		).toEqual([])
		expect(ingestRuleProblems({ signals: ["traces", "logs"], conditions: [], action: redact() })).toEqual(
			[],
		)
	})

	it("refuses a drop rule with no condition, so one click cannot discard everything", () => {
		expect(
			ingestRuleProblems({
				signals: ["logs"],
				conditions: [],
				action: { _tag: "drop", keepPercent: 0 },
			}),
		).toContain("a drop rule needs at least one condition")
	})

	it("refuses fields on signals that do not have them", () => {
		expect(
			ingestRuleProblems({
				signals: ["traces"],
				conditions: [{ field: "severity", op: "lt", value: "info" }],
				action: redact(),
			}),
		).toContain("condition 1: severity only applies to logs")
		expect(
			ingestRuleProblems({
				signals: ["metrics"],
				conditions: [],
				action: redact({ scopes: ["body"] }),
			}),
		).toContain("body only applies to logs")
	})

	it("lets rules redact Maple keys that carry customer text", () => {
		expect(ingestRuleProblems({ signals: ["traces"], conditions: [], action: redact({ keys: ["maple_ai.tool.error_result"] }) })).toEqual([])
	})

	it("refuses redacting keys Maple routes and bills on", () => {
		expect(
			ingestRuleProblems({
				signals: ["logs"],
				conditions: [],
				action: redact({ keys: ["service.name", "maple_org_id"] }),
			}),
		).toEqual([
			"service.name is used by Maple and cannot be redacted",
			"maple_org_id is used by Maple and cannot be redacted",
		])
	})

	it("checks operands per op", () => {
		const problems = (condition: IngestRuleSpec["conditions"][number]) =>
			ingestRuleProblems({
				signals: ["traces"],
				conditions: [condition],
				action: { _tag: "drop", keepPercent: 0 },
			})
		expect(problems({ field: "attribute", op: "eq", value: "x" })).toEqual([
			"condition 1: attribute needs a key",
		])
		expect(problems({ field: "attribute", key: "k", op: "in", values: [] })).toEqual([
			"condition 1: in needs at least one value",
		])
		expect(problems({ field: "attribute", key: "k", op: "exists", value: "x" })).toEqual([
			"condition 1: exists takes no value",
		])
		expect(problems({ field: "span_kind", op: "in", values: ["sever"] })).toEqual([
			"condition 1: span_kind values are unspecified, internal, server, client, producer, consumer",
		])
		expect(problems({ field: "attribute", key: "k", op: "regex", value: "(?=x)" })).toEqual([
			"condition 1: lookaround is not supported",
		])
	})

	it("only drops metrics entirely", () => {
		expect(
			ingestRuleProblems({
				signals: ["metrics"],
				conditions: [{ field: "name", op: "eq", value: "x" }],
				action: { _tag: "drop", keepPercent: 10 },
			}),
		).toEqual(["metrics can only be dropped entirely (keep 0%)"])
	})
})
