import { describe, expect, it } from "vitest"

import {
	commonErrorPrefix,
	errorTextTokens,
	errorTrendBucket,
	failureStatus,
	fillTrend,
	formatErrorPath,
	parseErrorPath,
	parsePayload,
	payloadLines,
	resolveErrorPath,
	unwrapToolErrorText,
	variantDifferences,
	whatsWrong,
	type ErrorTextToken,
} from "./tool-error-display"

// Verbatim shapes of production tool failures: a schema decoder's message in a
// `{"result": …}` envelope, an MCP parameter error, a templated domain error,
// and a backend error carrying volatile numbers.
const EXPECTED_ARRAY = 'Invalid tool input: Expected array\n  at ["evidence"]'
const MISSING_NESTED = 'Invalid tool input: Missing key\n  at ["evidence"][0]["traceIds"]'
const MISSING_ROOT = 'Invalid tool input: Missing key\n  at ["claim"]'
const GROUP_BY =
	'Tool failed: Invalid group_by "service.version" for source="traces" kind="breakdown". Valid group_by values: "service", "span_name".'
const TOO_EXPENSIVE = "Timeseries query too expensive\nRequested 2154 points, maximum is 1500"

/** Tokens as text, so a test reads like the row it describes. */
const render = (tokens: ReadonlyArray<ErrorTextToken>): string =>
	tokens
		.map((token) => {
			switch (token.kind) {
				case "text":
					return token.text
				case "value":
					return `*${token.text}*`
				case "mask":
					return `{${token.label}}`
				case "at":
					return " at "
				case "break":
					return " ⏎ "
				case "path":
					return token.parts.map((part) => (part.kind === "key" ? part.text : `{${part.label}}`)).join("")
			}
		})
		.join("")

describe("unwrapToolErrorText", () => {
	it("reads the message out of a tool result's envelope", () => {
		expect(unwrapToolErrorText(JSON.stringify({ result: EXPECTED_ARRAY }))).toEqual({
			text: EXPECTED_ARRAY,
			source: "result.result",
		})
		expect(unwrapToolErrorText('{"error":{"message":"boom"}}')).toEqual({
			text: "boom",
			source: "result.error.message",
		})
		expect(unwrapToolErrorText('{"message":"nope"}')).toEqual({ text: "nope", source: "result.message" })
	})

	it("leaves anything else as it came", () => {
		expect(unwrapToolErrorText("effect-agent.execute_tool: failed")).toEqual({
			text: "effect-agent.execute_tool: failed",
		})
		expect(unwrapToolErrorText('{"passed": 3}')).toEqual({ text: '{"passed": 3}' })
		// Truncated by the index: not JSON any more, so shown raw.
		expect(unwrapToolErrorText('{"result":"Invalid tool')).toEqual({ text: '{"result":"Invalid tool' })
	})
})

describe("commonErrorPrefix", () => {
	it("hoists the shared prefix up to its last colon", () => {
		expect(commonErrorPrefix([EXPECTED_ARRAY, MISSING_NESTED, MISSING_ROOT])).toBe("Invalid tool input: ")
		expect(commonErrorPrefix([GROUP_BY, "Tool failed: `group_by=attribute` requires `attribute_key`."])).toBe(
			"Tool failed: ",
		)
	})

	it("hoists nothing for one group, no shared colon, or a row it would empty", () => {
		expect(commonErrorPrefix([EXPECTED_ARRAY])).toBe("")
		expect(commonErrorPrefix(["upstream timed out", "upstream returned 503"])).toBe("")
		expect(commonErrorPrefix(["Tool failed: x", "Tool failed: "])).toBe("")
	})
})

describe("errorTextTokens", () => {
	it("picks out the error path, with an array index as a placeholder", () => {
		expect(render(errorTextTokens("Expected array\n  at [\"evidence\"]"))).toBe('Expected array at ["evidence"]')
		expect(render(errorTextTokens('Missing key\n  at ["evidence"][2]["traceIds"]'))).toBe(
			'Missing key at ["evidence"]{[*]}["traceIds"]',
		)
		expect(errorTextTokens('Missing key at ["claim"]').map((token) => token.kind)).toEqual([
			"text",
			"at",
			"path",
		])
	})

	it("emphasizes the backticked names and the first bare quoted value", () => {
		expect(render(errorTextTokens("`group_by=attribute` requires `attribute_key`."))).toBe(
			"*`group_by=attribute`* requires *`attribute_key`*.",
		)
		expect(render(errorTextTokens(GROUP_BY.slice("Tool failed: ".length)))).toBe(
			'Invalid group_by *"service.version"* for source="traces" kind="breakdown". Valid group_by values: "service", "span_name".',
		)
	})

	it("draws what the fingerprint ignores as placeholders, and a line break as a mark", () => {
		expect(render(errorTextTokens(TOO_EXPENSIVE))).toBe(
			"*Timeseries query too expensive* ⏎ Requested {<n>} points, maximum is {<n>}",
		)
		expect(
			render(errorTextTokens("Invalid parameters: SchemaError(`2026-09-04 00:00` is not a timestamp)")),
		).toBe("Invalid parameters: SchemaError(`{<ts>}` is not a timestamp)")
		expect(render(errorTextTokens("Elapsed 15346.717367 ms (query_id=7a3e91c4-5b02-4d8f)"))).toBe(
			"Elapsed {<n>}.{<n>} ms (query_id={<id>})",
		)
		// Digits inside an identifier: the grouping keeps the letters, so no chip
		// claims the identifier was ignored.
		expect(render(errorTextTokens("query_id=01M1XS1YN5140J9SMWJTC5GGMJ"))).toBe(
			"query_id=01M1XS1YN5140J9SMWJTC5GGMJ",
		)
		// A hex-letter word is still a word.
		expect(render(errorTextTokens("facade failed"))).toBe("facade failed")
	})
})

describe("the error path", () => {
	it("parses keys and indices, escapes included", () => {
		expect(parseErrorPath(MISSING_NESTED)).toEqual(["evidence", 0, "traceIds"])
		expect(parseErrorPath('SchemaError(Missing key at ["a\\"b"])')).toEqual(['a"b'])
		expect(parseErrorPath(TOO_EXPENSIVE)).toBeUndefined()
		expect(formatErrorPath(["evidence", 0, "traceIds"])).toBe("evidence[0].traceIds")
	})

	it("resolves against the arguments, telling a missing key from a null one", () => {
		const args = { evidence: [{ note: "x", traceIds: null }] }
		expect(resolveErrorPath(args, ["evidence", 0, "traceIds"])).toEqual({ found: true, value: null })
		expect(resolveErrorPath(args, ["evidence", 1])).toEqual({ found: false })
		expect(resolveErrorPath(args, ["claim"])).toEqual({ found: false })
	})
})

describe("whatsWrong", () => {
	it("says a JSON value was sent quoted, when the arguments show it", () => {
		const args = { claim: "c", evidence: '[{"note": "disk full"}]' }
		expect(whatsWrong(EXPECTED_ARRAY, args)).toEqual({
			subject: "evidence",
			text: "is a string that contains a JSON array. The schema expects the array itself — it was sent quoted.",
		})
		expect(whatsWrong('Expected object | null\n  at ["report"]', { report: '{"scope": 1}' })?.subject).toBe(
			"report",
		)
	})

	it("names the object a required key is missing from", () => {
		expect(whatsWrong(MISSING_NESTED, { evidence: [{ note: "x" }] })).toEqual({
			subject: "evidence[0]",
			text: "has no traceIds key, which is required on every evidence item.",
		})
		expect(whatsWrong(MISSING_ROOT, {})).toEqual({
			subject: "claim",
			text: "is required, and the arguments have no such key.",
		})
	})

	it("says nothing it cannot confirm", () => {
		// A string that is not JSON is a different mistake.
		expect(whatsWrong(EXPECTED_ARRAY, { evidence: "disk full" })).toBeUndefined()
		// The key is there after all.
		expect(whatsWrong(MISSING_ROOT, { claim: "c" })).toBeUndefined()
		// No arguments recorded, or a failure outside the schema family.
		expect(whatsWrong(EXPECTED_ARRAY, undefined)).toBeUndefined()
		expect(whatsWrong(TOO_EXPENSIVE, { points: 2154 })).toBeUndefined()
	})
})

describe("variantDifferences", () => {
	it("picks out the index a group's variants differ by, inside their path", () => {
		const texts = [0, 1, 2].map((index) => `Invalid tool input: Missing key\n  at ["evidence"][${index}]["traceIds"]`)
		expect(variantDifferences(texts)).toEqual(
			[0, 1, 2].map((index) => ({ before: '["evidence"]', middle: `[${index}]`, after: '["traceIds"]' })),
		)
	})

	it("keeps a little context either side where there is no path", () => {
		const [first] = variantDifferences([
			"Timeseries query too expensive\nRequested 2154 points, maximum is 1500",
			"Timeseries query too expensive\nRequested 1790 points, maximum is 1500",
		])
		expect(first).toEqual({ before: "…Requested ", middle: "2154", after: " points, m…" })
		expect(variantDifferences(["only one"])).toEqual([{ before: "", middle: "only one", after: "" }])
	})
})

describe("payloadLines", () => {
	it("highlights the value at the path and says what it is", () => {
		const args = { claim: "c", evidence: `[{"note": "${"x".repeat(300)}"}]` }
		const lines = payloadLines(args, EXPECTED_ARRAY)
		const highlighted = lines.filter((line) => line.highlight)
		expect(highlighted).toHaveLength(1)
		expect(highlighted[0]!.text.startsWith('"evidence": "[{\\"note\\"')).toBe(true)
		expect(highlighted[0]!.note?.text).toBe("string, expected array")
		expect(highlighted[0]!.note?.hiddenBytes).toBeGreaterThan(0)
	})

	it("writes a missing key into the object that lacks it, and folds that object's siblings", () => {
		const args = { evidence: [{ note: "first" }, { note: "second", traceIds: ["t"] }] }
		const lines = payloadLines(args, MISSING_NESTED)
		expect(lines.find((line) => line.missingKey !== undefined)?.missingKey).toBe("traceIds")
		expect(lines.filter((line) => line.highlight).map((line) => line.text)).toEqual([
			"{",
			'"note": "first"',
			"",
			"},",
		])
		const folded = lines.find((line) => line.folded !== undefined)
		expect(folded?.text).toBe('{ "note": "…", "traceIds": […] }')
		expect(folded?.folded).toMatch(/^item \[1\] · \d+ B$/)
	})

	it("cuts long strings off the path, and highlights nothing without one", () => {
		const lines = payloadLines({ output: "y".repeat(500) }, TOO_EXPENSIVE)
		expect(lines.some((line) => line.highlight)).toBe(false)
		expect(lines[1]!.text.endsWith(' …"')).toBe(true)
		expect(parsePayload('{"a": 1')).toBeUndefined()
		expect(parsePayload("{}")).toEqual({})
	})
})

describe("failureStatus", () => {
	const now = Date.UTC(2026, 8, 11, 12)
	const DAY = 86_400_000

	it("calls a failure stopped once the calls since would have repeated it", () => {
		// 387 of 979 calls failed; 281 calls since would have held ~111 of them.
		expect(
			failureStatus({ lastSeen: now - 4 * DAY, callsSince: 281, failures: 387, calls: 979, nowMs: now }),
		).toEqual({ kind: "stopped", since: now - 4 * DAY, callsSince: 281 })
	})

	it("keeps a rare failure ongoing through a quiet stretch too short to mean anything", () => {
		// 14 of 1,785 calls: 40 calls since would have held under one.
		expect(
			failureStatus({ lastSeen: now - 22 * 3_600_000, callsSince: 40, failures: 14, calls: 1_785, nowMs: now })
				.kind,
		).toBe("ongoing")
		expect(failureStatus({ lastSeen: now - 60_000, callsSince: 900, failures: 1, calls: 1_000, nowMs: now }).kind).toBe(
			"ongoing",
		)
	})

	it("reads a tool nobody has called since as quiet, not fixed", () => {
		expect(failureStatus({ lastSeen: now - 2 * DAY, callsSince: 0, failures: 4, calls: 4, nowMs: now })).toEqual({
			kind: "quiet",
			since: now - 2 * DAY,
		})
	})
})

describe("the trend", () => {
	it("reads a week in days and a day in three-hour buckets", () => {
		const end = Date.UTC(2026, 8, 11, 12)
		expect(errorTrendBucket(end - 7 * 86_400_000, end)).toEqual({ seconds: 86_400, unit: "day" })
		expect(errorTrendBucket(end - 86_400_000, end).seconds).toBe(10_800)
		expect(errorTrendBucket(end - 90 * 86_400_000, end).unit).toBe("week")
	})

	it("fills every bucket of the window, snapped as the warehouse snaps them", () => {
		const day = 86_400_000
		const start = Date.UTC(2026, 8, 4, 9)
		const end = Date.UTC(2026, 8, 11, 9)
		const trend = [
			{ bucket: Date.UTC(2026, 8, 4), calls: 11 },
			{ bucket: Date.UTC(2026, 8, 7), calls: 159 },
		]
		const filled = fillTrend(trend, start, end, day / 1000)
		expect(filled).toHaveLength(8)
		expect(filled).toEqual([11, 0, 0, 159, 0, 0, 0, 0])
	})
})
