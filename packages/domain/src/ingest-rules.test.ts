import { describe, expect, it } from "vitest"
import { Option } from "effect"
import { compileIngestRegex, ingestRuleProblems, regexProblem, type IngestRuleSpec } from "./ingest-rules"

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
		expect(regexProblem("(ab){3}c")).toBeNull()
		expect(regexProblem("(?<id>[0-9]{4})-[a-z]+")).toBeNull()
		expect(regexProblem("[(+]+x")).toBeNull()
		expect(regexProblem("\\^+x")).toBeNull()
		expect(regexProblem("a\\$+")).toBeNull()
		expect(regexProblem("[a$]+x")).toBeNull()
		expect(regexProblem("[^^]+x")).toBeNull()
		expect(regexProblem("[\\]^]*x")).toBeNull()
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
		["((a+))+$", "a repeated group may not contain a repetition or alternation"],
		["((a)+)+$", "a repeated group may not contain a repetition or alternation"],
		["(?:(a+))+$", "a repeated group may not contain a repetition or alternation"],
		["(a{1,2})+$", "a repeated group may not contain a repetition or alternation"],
		["(a?){2,}$", "a repeated group may not contain a repetition or alternation"],
		["[a&&b]", "character class set operations are not supported"],
		["[^]x", "use an explicit class or escape instead"],
		["x{1000}", "counted repetitions are limited to 999"],
		["(", "pattern is not a valid regular expression"],
		["", "pattern is empty"],
		["[^ ]+\\B{0,64}b", "\\b, \\B, ^ and $ cannot be repeated"],
		["^+a", "\\b, \\B, ^ and $ cannot be repeated"],
		["\\p{L", "pattern is not a valid regular expression"],
		["(\\u{41)+", "pattern is not a valid regular expression"],
		["[\\W_]", "inside [...], use explicit characters instead of \\D, \\W, \\S, \\b, \\B or a nested ["],
		["[[a]]", "inside [...], use explicit characters instead of \\D, \\W, \\S, \\b, \\B or a nested ["],
	])("rejects %s", (pattern, problem) => {
		expect(regexProblem(pattern)).toBe(problem)
	})

	const SLOW =
		"two repetitions that can match the same text need a character neither matches between them (a*a*b is too slow to match)"

	it.each([
		"a*a*b",
		"a+a+b",
		".*.*=",
		"x.*y.*z",
		"\\w*\\w*!",
		"(?:a*)a*b",
		"(?i)A*a*b",
		"[0-9]{0,99}[0-9]{0,99}x",
		"(?i)\\p{L}*\\x41*\\p{Lu}{3,}$",
	])("rejects %s, which backtracks for minutes in the preview's engine", (pattern) => {
		expect(regexProblem(pattern)).toBe(SLOW)
	})

	const TOO_LARGE =
		"pattern is too large for the gateway to compile; repeat \\w, \\d or \\p{...} less, or use an ASCII class like [A-Za-z0-9_]"

	// The gateway's regex crate caps a compiled pattern at 1 MiB; Unicode classes are large.
	it.each(["\\w{32}", "a*\\p{Lu}{0,64}!", "\\w{12}\\w{12}", "(?:\\w{5}){5}", "(?:\\w{12}|\\w{12})"])(
		"rejects %s, which the gateway could not compile",
		(pattern) => {
			expect(regexProblem(pattern)).toBe(TOO_LARGE)
		},
	)

	it("accepts long ASCII repeats and short Unicode ones", () => {
		expect(regexProblem("[A-Za-z0-9_]{32}")).toBeNull()
		expect(regexProblem("\\w{16}")).toBeNull()
		expect(regexProblem("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")).toBeNull()
	})

	it.each([
		"[a-z]+@[a-z]+\\.[a-z]{2,6}",
		"\\w+\\s+\\w+",
		"\\d{1,3}\\.\\d{1,3}",
		"password=.*",
		"\\d+-\\d+",
		"[^@]+@",
		"\\d{1,3}\\d{1,3}",
	])("accepts %s, whose repetitions are separated or short", (pattern) => {
		expect(regexProblem(pattern)).toBeNull()
	})
})

describe("compileIngestRegex", () => {
	const matches = (pattern: string, text: string) =>
		Option.match(compileIngestRegex(pattern, false), {
			onNone: () => null,
			onSome: (regex) => regex.test(text),
		})

	it("gives shorthand classes the gateway's Unicode meaning", () => {
		expect(matches("^\\w+$", "café_٣")).toBe(true)
		expect(matches("^\\d+$", "٣٤٥")).toBe(true)
		expect(matches("^\\s$", "\u00a0")).toBe(true)
		expect(matches("^\\s$", "\ufeff")).toBe(false)
		expect(matches("\\bé", "café")).toBe(false)
		expect(matches("^[\\d_]+$", "٣_1")).toBe(true)
	})

	it("lets . match every character but a newline, as the gateway does", () => {
		expect(matches("^a.b$", "a\rb")).toBe(true)
		expect(matches("^a.b$", "a\u2028b")).toBe(true)
		expect(matches("^a.b$", "a\nb")).toBe(false)
		expect(matches("^a\\.b$", "axb")).toBe(false)
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
		expect(
			ingestRuleProblems({
				signals: ["traces"],
				conditions: [],
				action: redact({ keys: ["maple_ai.tool.error_result"] }),
			}),
		).toEqual([])
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
		expect(
			ingestRuleProblems({
				signals: ["logs"],
				conditions: [{ field: "severity", op: "lt", value: "toString" }],
				action: { _tag: "drop", keepPercent: 0 },
			}),
		).toEqual(["condition 1: severity is one of trace, debug, info, warn, error, fatal"])
		expect(problems({ field: "attribute", key: "k", op: "regex", value: "(?=x)" })).toEqual([
			"condition 1: lookaround is not supported",
		])
	})

	it("keeps keep percent a whole number from 0 to 100", () => {
		const keep = (keepPercent: number) =>
			ingestRuleProblems({
				signals: ["logs"],
				conditions: [{ field: "severity", op: "lt", value: "info" }],
				action: { _tag: "drop", keepPercent },
			})
		expect(keep(50)).toEqual([])
		expect(keep(12.5)).toEqual(["keep percent is a whole number from 0 to 100"])
		expect(keep(101)).toEqual(["keep percent is a whole number from 0 to 100"])
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
