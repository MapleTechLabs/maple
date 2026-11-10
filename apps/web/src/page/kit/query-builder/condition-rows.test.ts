import { parseWhereClause } from "@maple/domain/where-clause"
import { describe, expect, test } from "vitest"
import {
	type ConditionRow,
	isUnspellable,
	nextRowId,
	parseConditionRows,
	printConditionRows,
	printConditionRowsOver,
	sameConditions,
	unshowableReasonOf,
} from "./condition-rows"
import { Array as Arr, Option } from "effect"

type DataSource = Parameters<typeof parseConditionRows>[1]

const rowsOf = (whereClause: string, dataSource: DataSource = "traces") =>
	Option.map(parseConditionRows(whereClause, dataSource), (rows) =>
		Arr.map(rows, ({ key, operator, values }) => ({ key, operator, values })),
	)

const row = (key: string, operator: ConditionRow["operator"], values: ReadonlyArray<string>, id = "c0") => ({
	id,
	key,
	operator,
	values,
})

describe("parseConditionRows", () => {
	test.each([
		["", []],
		['service.name = "checkout"', [{ key: "service.name", operator: "=", values: ["checkout"] }]],
		[
			'(attr.http.route = "/cart" OR attr.http.route = "/pay")',
			[{ key: "attr.http.route", operator: "=", values: ["/cart", "/pay"] }],
		],
		// A group of one is a plain clause, on any field.
		['(service.name = "checkout")', [{ key: "service.name", operator: "=", values: ["checkout"] }]],
		// AND-ed excludes are one row on any field: every source applies them.
		[
			'service.name != "a" AND service.name != "b"',
			[{ key: "service.name", operator: "!=", values: ["a", "b"] }],
		],
		["attr.http.route exists", [{ key: "attr.http.route", operator: "exists", values: [] }]],
		["resource.host.name !exists", [{ key: "resource.host.name", operator: "!exists", values: [] }]],
		[
			"attr.http.response.status_code >= 500",
			[{ key: "attr.http.response.status_code", operator: ">=", values: ["500"] }],
		],
		// Aliases read as their canonical key.
		[
			"service = checkout AND env = prod",
			[
				{ key: "service.name", operator: "=", values: ["checkout"] },
				{ key: "deployment.environment", operator: "=", values: ["prod"] },
			],
		],
		// Negations of one key fold into one row.
		[
			'severity != "DEBUG" AND severity != "TRACE"',
			[{ key: "severity", operator: "!=", values: ["DEBUG", "TRACE"] }],
		],
		// Attribute keys keep their case.
		["attr.userId = 'u_1'", [{ key: "attr.userId", operator: "=", values: ["u_1"] }]],
		['body contains "timed out"', [{ key: "body", operator: "contains", values: ["timed out"] }]],
	])("%s", (whereClause, expected) => {
		expect(rowsOf(whereClause)).toEqual(Option.some(expected))
	})

	test.each([
		// Not the grammar at all.
		"service.name ~ checkout",
		'service.name = "unclosed',
		// OR groups a row cannot show: mixed keys, mixed or negated operators, a named field, nesting.
		'(service.name = "a" OR span.name = "b")',
		'(service.name = "a" OR service.name = "b")',
		'(service.name = "a" OR service.name contains "b")',
		'(service.name != "a" OR service.name != "b")',
		'(service.name = "a" OR (span.name = "b"))',
		// A group without orGroups support in a row: AND inside parentheses.
		'(service.name = "a" AND span.name = "b")',
	])("%s cannot be shown", (whereClause) => {
		expect(Option.isNone(parseConditionRows(whereClause, "traces"))).toBe(true)
	})
})

describe("printConditionRows", () => {
	test.each([
		[[row("service.name", "=", ["checkout"])], 'service.name = "checkout"'],
		[
			[row("attr.http.route", "=", ["/cart", "/pay"])],
			'(attr.http.route = "/cart" OR attr.http.route = "/pay")',
		],
		[[row("severity", "!=", ["DEBUG", "TRACE"])], 'severity != "DEBUG" AND severity != "TRACE"'],
		[[row("attr.http.route", "exists", [])], "attr.http.route exists"],
		[[row("attr.http.response.status_code", ">", ["499"])], "attr.http.response.status_code > 499"],
		[[row("root_only", "=", ["true"])], "root_only = true"],
		// A value holding a double quote takes single quotes.
		[[row("span.name", "contains", ['say "hi"'])], `span.name contains 'say "hi"'`],
		[
			[row("service.name", "=", ["checkout"]), row("deployment.environment", "!exists", [], "c1")],
			'service.name = "checkout" AND deployment.environment !exists',
		],
	])("%j", (rows, expected) => {
		expect(printConditionRows(rows)).toBe(expected)
	})

	test("unfinished rows print nothing", () => {
		expect(
			printConditionRows([
				row("", "=", []),
				row("service.name", "=", [], "c1"),
				row("span.name", "=", ["GET /"], "c2"),
			]),
		).toBe('span.name = "GET /"')
	})
})

describe("round trip", () => {
	// What the grammar reads, order-free: the builder may reorder AND-ed clauses.
	const meaning = (whereClause: string) => {
		const parsed = parseWhereClause(whereClause, { orGroups: true })
		const keyed = (clause: { key: string; operator: string; value: string }) =>
			`${clause.key} ${clause.operator} ${clause.value}`
		return {
			clauses: Arr.sort(Arr.map(parsed.clauses, keyed), (a: string, b: string) =>
				a < b ? -1 : a > b ? 1 : 0,
			),
			groups: Arr.map(parsed.groups, (group) => Arr.map(group, keyed)),
			warnings: parsed.warnings.length,
		}
	}

	test.each([
		'service.name = "checkout"',
		'service.name = checkout AND span.name contains "GET /api"',
		'(attr.http.route = "/a" OR attr.http.route = "/b") AND has_error = true',
		'severity != "DEBUG" AND service.name = "x" AND severity != "TRACE"',
		"attr.http.response.status_code >= 500 AND attr.http.response.status_code < 600",
		"resource.k8s.pod.name exists AND attr.db.system !exists",
		`attr.message contains 'it''s' AND span.name = 'say "hi"'`,
		'(attr.error.message contains "timeout" OR attr.error.message contains "refused")',
	])("%s", (whereClause) => {
		const rows = Option.getOrThrow(parseConditionRows(whereClause, "traces"))
		const printed = printConditionRows(rows)
		expect(meaning(printed)).toEqual(meaning(whereClause))
		expect(
			Option.map(parseConditionRows(printed, "traces"), (again) => Arr.map(again, (r) => r.values)),
		).toEqual(Option.some(Arr.map(rows, (r) => r.values)))
	})
})

describe("nextRowId", () => {
	test("is past every id in use", () => {
		expect(nextRowId([])).toBe("c0")
		expect(nextRowId([row("a", "=", [], "c0"), row("b", "=", [], "c4")])).toBe("c5")
	})
})

describe("printConditionRowsOver", () => {
	const original =
		"service = checkout AND attr.http.route exists AND severity != DEBUG AND severity != TRACE"
	const rows = Option.getOrThrow(parseConditionRows(original, "logs"))

	test("untouched rows keep their text, a changed row is printed afresh", () => {
		const edited = Arr.map(rows, (row) =>
			row.key === "attr.http.route" ? { ...row, operator: "!exists" as const } : row,
		)
		expect(printConditionRowsOver(edited, original, "logs")).toBe(
			"service = checkout AND attr.http.route !exists AND severity != DEBUG AND severity != TRACE",
		)
	})

	test("a removed row drops only its text", () => {
		expect(
			printConditionRowsOver(
				Arr.filter(rows, (row) => row.key !== "attr.http.route"),
				original,
				"logs",
			),
		).toBe("service = checkout AND severity != DEBUG AND severity != TRACE")
	})
})

describe("sameConditions", () => {
	test("ignores ids and unfinished rows, not order or values", () => {
		const a = [row("service.name", "=", ["a"], "c0"), row("", "=", [], "c1")]
		expect(sameConditions(a, [row("service.name", "=", ["a"], "c9")])).toBe(true)
		expect(sameConditions(a, [row("service.name", "=", ["b"])])).toBe(false)
		expect(
			sameConditions(
				[row("a", "exists", []), row("b", "exists", [], "c1")],
				[row("b", "exists", []), row("a", "exists", [], "c1")],
			),
		).toBe(false)
	})
})

describe("isUnspellable", () => {
	test("only a value with both quote kinds", () => {
		expect(Arr.map([`it's`, `say "hi"`, `it's "on"`], isUnspellable)).toEqual([false, false, true])
	})
})

describe("unshowableReasonOf", () => {
	test.each([
		['service.name = "a" AND attr.b exists', Option.none()],
		['(attr.a = "1" OR attr.a = "2")', Option.none()],
		['(service.name = "a" OR span.name = "b")', Option.some("mixedFields")],
		['(service.name = "a" OR service.name contains "b")', Option.some("orOperators")],
		['(service.name != "a" OR service.name != "b")', Option.some("orOperators")],
		['(service.name = "checkout" OR service.name = "worker")', Option.some("orNotApplied")],
		["attr.b exists AND (has_error = true OR has_error = false)", Option.some("orNotApplied")],
		["service.name ~ checkout", Option.some("syntax")],
		// A missing value or a doubled operator: the grammar reads the stray `=` as the value.
		["service.name =", Option.some("syntax")],
		["service.name ==", Option.some("syntax")],
		["service.name >=", Option.some("syntax")],
		["service.name ==checkout", Option.some("syntax")],
		['service.name = "a" AND attr.b !==', Option.some("syntax")],
		['(attr.a = "1" OR attr.a ==)', Option.some("syntax")],
		// Quoted, the same characters are a value the user meant.
		['attr.a = "="', Option.none()],
		["attr.a = '=x'", Option.none()],
		["attr.duration >= 5", Option.none()],
		['service.name = "a" AND (service.name = "b" AND span.name = "c")', Option.some("syntax")],
	])("%s", (whereClause, expected) => {
		expect(unshowableReasonOf(whereClause, "traces")).toEqual(expected)
	})
})

// An OR group reads as a multi-value row only where the source applies it (the engine's
// `whereKeyMatchesAnyOf`); anywhere else a row would hold one value and a pick would drop the rest.
describe("OR groups by source", () => {
	const twoValues = (key: string) => `(${key} = "a" OR ${key} = "b")`

	test.each([
		["traces", "attr.http.route"],
		["traces", "resource.host.name"],
		// Traces read a bare unknown key as a span attribute.
		["traces", "db.system"],
		["logs", "attr.http.route"],
		["logs", "resource.host.name"],
		["metrics", "attr.state"],
	] as const)("%s ORs %s: one row, two values", (dataSource, key) => {
		expect(rowsOf(twoValues(key), dataSource)).toEqual(
			Option.some([{ key, operator: "=", values: ["a", "b"] }]),
		)
		expect(unshowableReasonOf(twoValues(key), dataSource)).toEqual(Option.none())
	})

	test.each([
		["traces", "service.name"],
		["traces", "span.name"],
		["traces", "deployment.environment"],
		["logs", "service.name"],
		["logs", "severity"],
		// Logs and metrics drop a bare unknown key.
		["logs", "db.system"],
		["metrics", "service.name"],
		["metrics", "db.system"],
		// Product events lower no OR group at all.
		["product_events", "event.name"],
		["product_events", "attr.plan"],
		["product_events", "plan"],
	] as const)("%s does not OR %s: it stays in Text", (dataSource, key) => {
		expect(rowsOf(twoValues(key), dataSource)).toEqual(Option.none())
		expect(unshowableReasonOf(twoValues(key), dataSource)).toEqual(Option.some("orNotApplied"))
	})

	test("a product-events OR across fields still reads as mixed fields", () => {
		expect(unshowableReasonOf('(event.name = "a" OR host = "b")', "product_events")).toEqual(
			Option.some("mixedFields"),
		)
	})
})
