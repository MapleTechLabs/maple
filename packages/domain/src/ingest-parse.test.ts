import { describe, expect, it } from "vitest"
import { Array as Arr, String as Str } from "effect"
import { expandGrok } from "./ingest-grok"
import {
	ingestRuleProblems,
	summarizeIngestRule,
	type IngestParseStep,
	type IngestRuleSpec,
} from "./ingest-rules"

const parseRule = (steps: ReadonlyArray<IngestParseStep>, signals: IngestRuleSpec["signals"] = ["logs"]) => ({
	signals,
	conditions: [],
	action: { _tag: "parse" as const, steps },
})

const regex = (pattern: string): IngestParseStep => ({ _tag: "regex", source: "body", pattern })
const grok = (pattern: string): IngestParseStep => ({ _tag: "grok", source: "body", pattern })

describe("parse rule validation", () => {
	it("accepts patterns a backtracking engine would choke on, since both engines are linear", () => {
		expect(ingestRuleProblems(parseRule([regex("^(?<a>.*) (?<b>.*)$")]))).toEqual([])
		expect(ingestRuleProblems(parseRule([regex("(?<x>(a+)+)b")]))).toEqual([])
		expect(
			ingestRuleProblems(parseRule([grok("%{DATA:path} %{NUMBER:status:int} %{GREEDYDATA:rest}")])),
		).toEqual([])
	})

	it.each([
		[[regex("(?<x>a)(?=b)")], "step 1: lookaround is not supported"],
		[[regex("[0-9]+")], "step 1: add a named group, like (?<status>[0-9]+)"],
		[[regex("\\Qa.b\\E(?<x>c)")], "step 1: \\Q, \\E and \\C are not supported"],
		[
			[regex("(?<x>[\\W])")],
			"step 1: inside [...], use explicit characters instead of \\D, \\W, \\S, \\b, \\B or a nested [",
		],
		[[regex("(?<a>[]\\D])")], "step 1: write a ] at the start of a class as \\]"],
		[[regex("(?<a>\\\\[]\\D])")], "step 1: write a ] at the start of a class as \\]"],
		[[grok("%{NOPE:x}")], "step 1: unknown grok pattern NOPE"],
		[[grok("%{WORD}")], "step 1: name at least one field, like %{WORD:method}"],
		[[grok("%{WORD:x:bool}")], "step 1: field type bool must be int or float"],
		[[grok("(?<x>a)%{WORD:y}")], "step 1: name fields with %{PATTERN:field}, not (?<name>...)"],
		[[{ _tag: "json", source: "attribute" } as const], "step 1: an attribute source needs a key"],
		[[{ _tag: "json", source: "body", key: "x" } as const], "step 1: the body takes no key"],
		[
			[{ _tag: "json", source: "body", prefix: Str.repeat(65)("p") } as const],
			"step 1: the prefix is longer than 64 characters",
		],
		[[], "add at least one step"],
	] as const)("refuses %j", (steps, problem) => {
		expect(ingestRuleProblems(parseRule(steps))).toContain(problem)
	})

	it("only parses logs", () => {
		expect(ingestRuleProblems(parseRule([regex("(?<a>x)")], ["logs", "traces"]))).toContain(
			"parse rules apply to logs only",
		)
	})

	it("summarizes the steps in order", () => {
		expect(
			summarizeIngestRule(
				parseRule([
					{ _tag: "json", source: "body" },
					{ _tag: "severity", source: "attribute", key: "level" },
				]),
			),
		).toBe("Parse logs with JSON, then severity")
	})
})

describe("expandGrok", () => {
	it("numbers field groups in order and keeps their types", () => {
		expect(expandGrok("%{INT:n:int} %{WORD}")).toEqual({
			regex: "(?<g0>[+-]?[0-9]+) (?:[A-Za-z0-9_]+)",
			fields: [{ name: "n", type: "int" }],
		})
	})

	it("expands fields inside library patterns", () => {
		const expanded = expandGrok("%{COMMONAPACHELOG}")
		expect(
			typeof expanded === "string" ? expanded : Arr.map(expanded.fields, (field) => field.name),
		).toEqual([
			"client.address",
			"ident",
			"auth",
			"timestamp",
			"http.request.method",
			"url.original",
			"network.protocol.version",
			"raw_request",
			"http.response.status_code",
			"http.response.body.size",
		])
	})

	it("reports an unclosed reference", () => {
		expect(expandGrok("%{WORD:x")).toBe("a %{ is not closed")
	})
})
