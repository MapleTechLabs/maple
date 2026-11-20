import { Result } from "effect"
import { describe, expect, it } from "vitest"
import type { Expr } from "./ast"
import { formatDuration, parseDurationMs } from "./literals"
import { parse } from "./parser"
import { print } from "./print"
import { checkTypes } from "./types"

const ok = (query: string): Expr => {
	const result = parse(query)
	if (Result.isFailure(result)) throw new Error(`${query}: ${result.failure.message}`)
	return result.success
}

const errorOf = (query: string): string => {
	const result = parse(query)
	return Result.isFailure(result) ? result.failure.message : "parsed"
}

describe("parse", () => {
	it("reads a selector with every matcher kind, offset and @", () => {
		expect(
			ok(
				'http_requests_total{job="api", code!="200", path=~"/v1/.*", method!~"GET|HEAD"} offset 5m @ 1600000000',
			),
		).toEqual({
			type: "VectorSelector",
			name: "http_requests_total",
			matchers: [
				{ name: "__name__", op: "=", value: "http_requests_total" },
				{ name: "job", op: "=", value: "api" },
				{ name: "code", op: "!=", value: "200" },
				{ name: "path", op: "=~", value: "/v1/.*" },
				{ name: "method", op: "!~", value: "GET|HEAD" },
			],
			offsetMs: 300_000,
			at: { kind: "time", timeMs: 1_600_000_000_000 },
		})
	})

	it("reads Prometheus 3 quoted names: the metric name as written, label names in the underscore form", () => {
		const expr = ok('{"http.server.duration", "service.name"="api", "1x-y..z"="v"}')
		expect(expr).toMatchObject({
			type: "VectorSelector",
			name: "http.server.duration",
			matchers: [
				{ name: "__name__", op: "=", value: "http.server.duration" },
				{ name: "service_name", op: "=", value: "api" },
				{ name: "_1x_y_z", op: "=", value: "v" },
			],
		})
	})

	it("escapes quoted label names in grouping, matching and label function arguments", () => {
		expect(ok('sum by ("http.route", __name__) (x)')).toMatchObject({
			grouping: ["http_route", "__name__"],
		})
		expect(ok('a * on ("k.8s") group_left ("x.y") b')).toMatchObject({
			matching: { labels: ["k_8s"], include: ["x_y"] },
		})
		expect(ok('label_replace(x, "dst.a", "$1", "src.b", "(.*)")')).toMatchObject({
			args: [{}, { value: "dst_a" }, { value: "$1" }, { value: "src_b" }, { value: "(.*)" }],
		})
		expect(ok('label_join(x, "d.a", "-", "s.1", "s.2")')).toMatchObject({
			args: [{}, { value: "d_a" }, { value: "-" }, { value: "s_1" }, { value: "s_2" }],
		})
		expect(ok('count_values("v.x", x)')).toMatchObject({ param: { value: "v_x" } })
		expect(ok('count_values(("v.x"), x)')).toMatchObject({ param: { expr: { value: "v_x" } } })
		expect(ok('label_replace(x, ("dst.a"), "$1", (("src.b")), "(.*)")')).toMatchObject({
			args: [{}, { expr: { value: "dst_a" } }, {}, { expr: { expr: { value: "src_b" } } }, {}],
		})
		expect(ok('x{foo__bar="1"}')).toMatchObject({ matchers: [{}, { name: "foo__bar" }] })
	})

	it("takes the metric name from a __name__ equality matcher", () => {
		expect(ok('{__name__="up", job="x"}')).toMatchObject({ name: "up" })
	})

	it("reads ranges, subqueries and negative offsets", () => {
		expect(ok("rate(x[1h30m])")).toMatchObject({
			type: "Call",
			func: "rate",
			args: [{ type: "MatrixSelector", rangeMs: 5_400_000 }],
		})
		expect(ok("max_over_time(rate(x[1m])[1h:5m] offset -1d)")).toMatchObject({
			args: [{ type: "Subquery", rangeMs: 3_600_000, stepMs: 300_000, offsetMs: -86_400_000 }],
		})
		expect(ok("x[5m:]")).toMatchObject({ type: "Subquery", stepMs: undefined })
	})

	it("keeps Prometheus operator precedence", () => {
		const expr = ok("a + b * c ^ d ^ e > bool 1 or f")
		expect(print(expr)).toBe("a + b * c ^ d ^ e > bool 1 or f")
		expect(expr).toMatchObject({
			type: "Binary",
			op: "or",
			lhs: { type: "Binary", op: ">", returnBool: true },
		})
		const pow = ok("c ^ d ^ e")
		expect(pow).toMatchObject({ op: "^", lhs: { name: "c" }, rhs: { op: "^" } })
	})

	it("reads vector matching clauses", () => {
		expect(ok("a / on(x, y) group_left(z) b")).toMatchObject({
			matching: { card: "many-to-one", on: true, labels: ["x", "y"], include: ["z"] },
		})
		expect(ok("a - ignoring(x) group_right b")).toMatchObject({
			matching: { card: "one-to-many", on: false, labels: ["x"], include: [] },
		})
		expect(ok("a and b")).toMatchObject({ matching: undefined })
	})

	it("reads aggregations with the modifier on either side", () => {
		const before = ok("sum by (job) (rate(x[5m]))")
		const after = ok("sum(rate(x[5m])) by (job)")
		expect(before).toEqual(after)
		expect(ok("topk(3, x) without (a)")).toMatchObject({
			op: "topk",
			param: { type: "NumberLiteral", value: 3 },
			without: true,
			grouping: ["a"],
		})
		expect(ok('count_values("v", x)')).toMatchObject({ op: "count_values", param: { value: "v" } })
	})

	it("reads number literals the way Go does", () => {
		expect(ok("0x1F")).toEqual({ type: "NumberLiteral", value: 31 })
		expect(ok("1e3")).toEqual({ type: "NumberLiteral", value: 1000 })
		expect(ok("-Inf")).toEqual({ type: "NumberLiteral", value: Number.NEGATIVE_INFINITY })
		expect(ok("1h")).toEqual({ type: "NumberLiteral", value: 3600 })
		expect(Number.isNaN((ok("NaN") as { value: number }).value)).toBe(true)
	})

	it("unquotes all three string forms", () => {
		expect(ok('label_replace(x, "a", "\\t$1", "b", "(.*)")')).toMatchObject({
			args: [{}, {}, { value: "\t$1" }, {}, {}],
		})
		expect(ok("x{a='it\\'s'}")).toMatchObject({ matchers: [{}, { value: "it's" }] })
		expect(ok("x{a=`raw\\n`}")).toMatchObject({ matchers: [{}, { value: "raw\\n" }] })
	})

	it("round-trips through print", () => {
		const queries = [
			'histogram_quantile(0.95, sum by (le, service) (rate(http_server_duration_bucket{env="prod"}[5m])))',
			"sum without (instance) (rate(x[5m])) / on(job) group_left(team) team_info",
			'{"a.b", c="d"}[1m] offset 1h',
			'{__name__="a", __name__="b"}',
			'{__name__="a.b", __name__="a.b"}',
			'{__name__="a.b", __name__=~"a.*"}',
			"-x + 2",
			"x @ start()",
			"avg_over_time(up[10m:1m])",
		]
		for (const query of queries) {
			const once = ok(query)
			expect(ok(print(once))).toEqual(once)
		}
	})
})

describe("parse errors", () => {
	it("rejects syntax errors with a position", () => {
		const result = parse("sum(rate(x[5m])")
		expect(Result.isFailure(result) && result.failure.message).toMatch(/syntax error|unexpected end/)
	})

	it("rejects type errors the way Prometheus does", () => {
		expect(errorOf("rate(x)")).toMatch(/expected type matrix/)
		expect(errorOf("sum(x[5m])")).toMatch(/expected type vector/)
		expect(errorOf("1 > 2")).toMatch(/BOOL modifier/)
		expect(errorOf("1 and x")).toMatch(/set operator/)
		expect(errorOf("a + bool b")).toMatch(/comparison operators/)
		expect(errorOf("a and on(x) group_left b")).toMatch(/no grouping allowed/)
		expect(errorOf("topk(x)")).toMatch(/wrong number of arguments/)
		expect(errorOf("clamp(x, 1)")).toMatch(/argument/)
		expect(errorOf("label_join(up)")).toBe(
			'expected at least 3 argument(s) in call to "label_join", got 1',
		)
	})

	it("points a type error at the expression it is about", () => {
		const positionOf = (query: string) => {
			const result = parse(query)
			return Result.isFailure(result) ? result.failure.position : -1
		}
		expect(positionOf('topk("v", up)')).toBe(5)
		expect(positionOf("sum(x[5m])")).toBe(4)
		expect(positionOf("up + rate(x)")).toBe(10)
	})

	it("reads a leading-zero integer as octal, as Prometheus does", () => {
		const value = (query: string) => {
			const result = parse(query)
			return Result.isSuccess(result) && result.success.type === "NumberLiteral"
				? result.success.value
				: undefined
		}
		expect(value("0755")).toBe(493)
		expect(value("0_755")).toBe(493)
		expect(value("08")).toBe(8)
		expect(value("0755.5")).toBe(755.5)
		const subquery = parse("vector(1)[010:1s]")
		expect(
			Result.isSuccess(subquery) && subquery.success.type === "Subquery" && subquery.success.rangeMs,
		).toBe(8000)
	})

	it("converts numeric durations and @ times the way Prometheus does", () => {
		const selectorOf = (query: string) => {
			const result = parse(query)
			if (Result.isFailure(result)) throw new Error(result.failure.message)
			const expr = result.success
			return expr.type === "MatrixSelector"
				? expr.vector
				: expr.type === "VectorSelector"
					? expr
					: undefined
		}
		// Nanoseconds, then truncated to milliseconds: 1.0006s is a 1000ms range.
		const range = parse("x[1.0006]")
		expect(
			Result.isSuccess(range) && range.success.type === "MatrixSelector" && range.success.rangeMs,
		).toBe(1000)
		expect(selectorOf("x offset 1.0006")?.offsetMs).toBe(1000)
		// @ rounds to whole milliseconds, halves away from zero.
		expect(selectorOf("x @ -0.0004")?.at).toEqual({ kind: "time", timeMs: 0 })
		expect(selectorOf("x @ -0.0005")?.at).toEqual({ kind: "time", timeMs: -1 })
		expect(selectorOf("x @ 0.0005")?.at).toEqual({ kind: "time", timeMs: 1 })
	})

	it("refuses durations past Go's int64 nanoseconds, as Prometheus does", () => {
		expect(parseDurationMs("1e300")).toBeUndefined()
		expect(parseDurationMs("999999999y")).toBeUndefined()
		expect(errorOf("count_over_time(x[1e300])")).not.toBe("parsed")
		expect(errorOf("x offset 1e300")).not.toBe("parsed")
		expect(parseDurationMs("292y")).toBe(292 * 365 * 86_400_000)
	})

	it("formats negative durations so they parse back", () => {
		expect(formatDuration(-90_000)).toBe("-1m30s")
		expect(parseDurationMs(formatDuration(5_400_000))).toBe(5_400_000)
	})

	it("rejects a repeated offset, including after offset 0s", () => {
		expect(errorOf("x offset 0s offset 5m")).toMatch(/offset may not be set multiple times/)
		expect(errorOf("x[5m] offset 1m offset 5m")).toMatch(/offset may not be set multiple times/)
		expect(errorOf("x offset 0s @ 100")).toBe("parsed")
	})

	it("rejects selectors that match everything and bad regexes", () => {
		expect(errorOf('{a=""}')).toMatch(/non-empty matcher/)
		expect(errorOf('{a=~".*"}')).toMatch(/non-empty matcher/)
		expect(errorOf('x{a=~"("}')).toMatch(/invalid regular expression/)
	})

	it("rejects unknown functions and experimental syntax", () => {
		expect(errorOf("nope(x)")).toMatch(/syntax error|unknown/)
		expect(errorOf("constructor(x)")).toMatch(/syntax error|unknown/)
		expect(errorOf("x offset 1m offset 2m")).not.toBe("parsed")
		expect(errorOf("sum(x) offset 5m")).toMatch(
			/preceded by an instant vector selector or range vector selector or a subquery/,
		)
	})
})

describe("label regexes follow Prometheus' RE2", () => {
	it("accepts RE2 syntax JavaScript lacks and rejects what RE2 rejects", () => {
		expect(errorOf('x{a=~"(?i)get"}')).toBe("parsed")
		expect(errorOf('x{a=~"[[:alpha:]]+"}')).toBe("parsed")
		expect(errorOf('x{a=~"(?=x)"}')).toMatch(/invalid regular expression/)
		expect(errorOf('x{a=~"(a)\\\\1"}')).toMatch(/invalid regular expression/)
	})
})

describe("print keeps meaning", () => {
	const v = (name: string): Expr => ({
		type: "VectorSelector",
		name,
		matchers: [{ name: "__name__", op: "=", value: name }],
		offsetMs: 0,
		at: undefined,
	})
	const bin = (op: "+" | "-" | "*", lhs: Expr, rhs: Expr): Expr => ({
		type: "Binary",
		op,
		lhs,
		rhs,
		returnBool: false,
		matching: undefined,
	})

	it("parenthesizes nested operators so precedence cannot regroup them", () => {
		expect(print(bin("*", bin("+", v("a"), v("b")), v("c")))).toBe("(a + b) * c")
		expect(print(bin("-", v("a"), bin("-", v("b"), v("c"))))).toBe("a - (b - c)")
		expect(ok(print(ok("a / ignoring() b")))).toEqual(ok("a / ignoring() b"))
	})

	it("fails cleanly on an escape past U+10FFFF", () => {
		expect(errorOf('x{a="\\U00110000"}')).toMatch(/invalid string literal/)
	})
})

describe("second-review parser regressions", () => {
	it("decodes byte escapes as UTF-8", () => {
		expect(ok('x{city="\\xc3\\xa9"}')).toMatchObject({ matchers: [{}, { value: "é" }] })
	})

	it("keeps a leading byte-order mark from byte escapes", () => {
		expect(ok('x{v="\\xef\\xbb\\xbfabc"}')).toMatchObject({ matchers: [{}, { value: "\uFEFFabc" }] })
	})

	it("parses the native-histogram functions and mad_over_time", () => {
		expect(errorOf("histogram_fraction(0, 0.2, x)")).toBe("parsed")
		expect(errorOf("mad_over_time(x[5m])")).toBe("parsed")
	})

	it("refuses a zero subquery step", () => {
		expect(errorOf("max_over_time(up[5m:0s])")).toMatch(/subquery step/)
	})

	it("accepts label_join with no source labels", () => {
		expect(errorOf('label_join(up, "joined", ",")')).toBe("parsed")
	})

	it("keeps a reserved metric name quoted", () => {
		const expr = ok('{"NaN"}')
		expect(ok(print(expr))).toEqual(expr)
	})
})

describe("third-review parser regressions", () => {
	it("reads exponent and hex numbers as range and offset durations", () => {
		expect(ok("rate(x[1e3])")).toMatchObject({ args: [{ rangeMs: 1_000_000 }] })
		expect(ok("x[1.5e3]")).toMatchObject({ rangeMs: 1_500_000 })
		expect(ok("x[0x10]")).toMatchObject({ rangeMs: 16_000 })
		expect(ok("x offset -1e3")).toMatchObject({ offsetMs: -1_000_000 })
	})

	it("accepts digit separators in numbers but not in unit durations", () => {
		expect(ok("1_000")).toEqual({ type: "NumberLiteral", value: 1000 })
		expect(ok("1_000.5")).toEqual({ type: "NumberLiteral", value: 1000.5 })
		expect(ok("1e1_0")).toEqual({ type: "NumberLiteral", value: 1e10 })
		expect(ok("x[1_000]")).toMatchObject({ rangeMs: 1_000_000 })
		expect(errorOf("1__0")).not.toBe("parsed")
		expect(errorOf("x offset 1_0s")).not.toBe("parsed")
	})

	it("reads a signed @ timestamp", () => {
		expect(ok("up @ -1")).toMatchObject({ at: { kind: "time", timeMs: -1000 } })
		expect(ok("up @ - 1.5")).toMatchObject({ at: { kind: "time", timeMs: -1500 } })
		expect(ok("up @ +2")).toMatchObject({ at: { kind: "time", timeMs: 2000 } })
	})

	it("drops an empty matching clause next to a scalar and keeps rejecting a non-empty one", () => {
		expect(ok("up / ignoring() 2")).toMatchObject({ type: "Binary", matching: undefined })
		expect(ok("2 * on() group_left(a) up")).toMatchObject({ type: "Binary", matching: undefined })
		expect(errorOf("up / ignoring(a) 2")).toMatch(/vector matching only allowed between instant vectors/)
	})

	it("rejects a label in both on() and the group list, but not with ignoring()", () => {
		expect(errorOf("a + on(job) group_left(job) b")).toBe(
			'label "job" must not occur in ON and GROUP clause at once',
		)
		expect(errorOf("a + on(job) group_right(job) b")).toMatch(/must not occur in ON and GROUP/)
		expect(errorOf("a + ignoring(job) group_left(job) b")).toBe("parsed")
	})

	it("keeps a negative base of ^ in parentheses", () => {
		const expr: Expr = {
			type: "Binary",
			op: "^",
			lhs: { type: "NumberLiteral", value: -2 },
			rhs: { type: "NumberLiteral", value: 2 },
			returnBool: false,
			matching: undefined,
		}
		expect(print(expr)).toBe("(-2) ^ 2")
		expect(ok(print(expr))).toEqual(ok("(-2) ^ 2"))
	})
})

describe("go-live parser fixes", () => {
	const num = (value: number): Expr => ({ type: "NumberLiteral", value })
	const sel = (name: string, offsetMs = 0) =>
		expect.objectContaining({ type: "VectorSelector", name, offsetMs })

	it("reads signed number literals where the grammar folds the sign into the token", () => {
		expect(ok("-1")).toEqual(num(-1))
		expect(ok("+1")).toEqual(num(1))
		expect(ok("-0x10")).toEqual(num(-16))
		expect(ok("-Inf")).toEqual(num(Number.NEGATIVE_INFINITY))
		expect(ok("--1")).toEqual(num(1))
		expect(ok("x > -5")).toMatchObject({ op: ">", rhs: num(-5) })
		expect(ok("x * -1")).toMatchObject({ op: "*", rhs: num(-1) })
		expect(ok("x * - 1")).toMatchObject({ op: "*", rhs: num(-1) })
		expect(ok("x + -1")).toMatchObject({ op: "+", rhs: num(-1) })
		expect(ok("2 ^ -1")).toMatchObject({ op: "^", lhs: num(2), rhs: num(-1) })
	})

	it("binds unary minus looser than ^ and as tight as *", () => {
		expect(ok("-2 ^ 2")).toEqual({
			type: "Unary",
			op: "-",
			expr: {
				type: "Binary",
				op: "^",
				lhs: num(2),
				rhs: num(2),
				returnBool: false,
				matching: undefined,
			},
		})
		expect(ok("2 * -3 ^ 2")).toMatchObject({ op: "*", rhs: { type: "Unary", expr: { op: "^" } } })
		expect(ok("-2 ^ 2 * 3")).toMatchObject({ op: "*", lhs: { type: "Unary" }, rhs: num(3) })
	})

	it("binds offset and @ after a binary operator to the right operand", () => {
		expect(ok("a / b offset 1d")).toMatchObject({ lhs: sel("a"), rhs: sel("b", 86_400_000) })
		expect(ok("x / x offset 1w")).toMatchObject({ lhs: sel("x"), rhs: sel("x", 604_800_000) })
		expect(ok("a > bool b offset 1m")).toMatchObject({ returnBool: true, rhs: sel("b", 60_000) })
		expect(ok("a / on(x) group_left b offset 1m")).toMatchObject({
			matching: { card: "many-to-one", labels: ["x"] },
			rhs: sel("b", 60_000),
		})
		expect(ok("sum(a) / b @ 100")).toMatchObject({
			lhs: { type: "Aggregate" },
			rhs: { name: "b", at: { kind: "time", timeMs: 100_000 } },
		})
		expect(ok("-up offset 1m")).toMatchObject({ type: "Unary", expr: sel("up", 60_000) })
		expect(ok("a + b offset 1m * c")).toMatchObject({ op: "+", rhs: { op: "*", lhs: sel("b", 60_000) } })
	})

	it("keeps rejecting what Prometheus rejects, with its messages", () => {
		const mixed = "binary expression must contain only scalar and instant vector types"
		expect(errorOf("vector(1) + vector(2)[5m:1m]")).toBe(mixed)
		expect(parse("vector(1) + vector(2)[5m:1m]")).toMatchObject({ failure: { position: 12 } })
		expect(errorOf("a + b[5m]")).toBe(mixed)
		expect(errorOf("-a[5m:]")).toBe(
			'unary expression only allowed on expressions of type scalar or instant vector, got "range vector"',
		)
		expect(errorOf("vector(1) + 2[5m:]")).toBe(
			"subquery is only allowed on instant vector, got scalar instead",
		)
		expect(errorOf("a offset 1m [5m]")).toBe("no offset modifiers allowed before range")
		expect(errorOf("(a + b) offset 1m")).toBe(
			"offset modifier must be preceded by an instant vector selector or range vector selector or a subquery",
		)
		expect(errorOf("sum(a) @ 100")).toMatch(/^@ modifier must be preceded/)
		expect(errorOf("x offset 1m @ 10 offset 2m")).toMatch(/offset may not be set multiple times/)
	})

	it("prints negative literals and modifiers on the right operand so they parse back", () => {
		for (const query of [
			"x > -5",
			"x * -1",
			"1 - -1",
			"2 ^ -1",
			"-2 ^ 2",
			"2 * -3 ^ 2",
			"-0",
			"a / b offset 1d",
			"sum(a) / b @ 100",
			"-up offset 1m",
		]) {
			expect(ok(print(ok(query))), query).toEqual(ok(query))
		}
		expect(print(ok("-2 ^ 2"))).toBe("-2 ^ 2")
		expect(print(ok("x * -1"))).toBe("x * -1")
	})
})

describe("fourth-review parser regressions", () => {
	it("rejects a number literal that overflows float64", () => {
		expect(errorOf("1e309")).toMatch(/error parsing number/)
		expect(errorOf("-1e309")).toMatch(/error parsing number/)
		expect(ok("Inf")).toEqual({ type: "NumberLiteral", value: Number.POSITIVE_INFINITY })
	})

	it("checks the int64 nanosecond limit before truncating a duration to ms", () => {
		expect(parseDurationMs("9223372036.8549")).toBeUndefined()
		expect(parseDurationMs("9223372036.854")).toBe(9_223_372_036_854)
		expect(parseDurationMs("1.0006")).toBe(1000)
	})

	it("parses limitk and limit_ratio", () => {
		expect(errorOf("limitk(1, up)")).toBe("parsed")
		expect(errorOf("limit_ratio(0.5, up)")).toBe("parsed")
	})

	it("skips a comment between @ and its timestamp", () => {
		expect(ok("up @ # pin\n10")).toMatchObject({ at: { kind: "time", timeMs: 10_000 } })
	})

	it("rejects an @ timestamp outside the int64 range", () => {
		expect(errorOf("up @ 1e306")).toMatch(/timestamp out of bounds for @ modifier/)
		expect(errorOf("max_over_time(up[5m:1m] @ 1e300)")).toMatch(/timestamp out of bounds/)
		expect(ok("up @ 1700000000.5")).toMatchObject({ at: { kind: "time", timeMs: 1_700_000_000_500 } })
	})

	it("accepts a trailing decimal point in numbers and durations", () => {
		expect(ok("1.")).toEqual({ type: "NumberLiteral", value: 1 })
		expect(ok("1.e2")).toEqual({ type: "NumberLiteral", value: 100 })
		expect(ok("x[2.]")).toMatchObject({ rangeMs: 2000 })
		expect(ok('x{a="1."} + 3.')).toMatchObject({
			lhs: { matchers: [{}, { value: "1." }] },
			rhs: { value: 3 },
		})
		expect(errorOf(".")).not.toBe("parsed")
		expect(errorOf("1..")).not.toBe("parsed")
	})

	it("reads a leading-zero number with a trailing dot as decimal, not octal", () => {
		// Go's ParseFloat reads `010.` as 10; only a dotless `010` is octal.
		expect(ok("010.")).toEqual({ type: "NumberLiteral", value: 10 })
		expect(ok("010")).toEqual({ type: "NumberLiteral", value: 8 })
		expect(ok("010.e1")).toEqual({ type: "NumberLiteral", value: 100 })
		expect(ok("0.")).toEqual({ type: "NumberLiteral", value: 0 })
		expect(ok("x[010.]")).toMatchObject({ rangeMs: 10_000 })
		// An error still points where the literal starts.
		expect(parse("sum(010.)")).toMatchObject({ failure: { position: 4 } })
	})

	it("parenthesizes a negative-zero base of ^", () => {
		const expr: Expr = {
			type: "Binary",
			op: "^",
			lhs: { type: "NumberLiteral", value: -0 },
			rhs: { type: "NumberLiteral", value: 2 },
			returnBool: false,
			matching: undefined,
		}
		expect(print(expr)).toBe("(-0) ^ 2")
		expect(print({ ...expr, lhs: { type: "NumberLiteral", value: 0 } })).toBe("0 ^ 2")
	})

	it("checks aggregation arity in checkTypes", () => {
		const up = ok("up")
		const agg = (op: "topk" | "sum", param: Expr | undefined): Expr => ({
			type: "Aggregate",
			op,
			expr: up,
			param,
			grouping: [],
			without: false,
		})
		expect(checkTypes(agg("topk", undefined))?.message).toMatch(/wrong number of arguments/)
		expect(checkTypes(agg("sum", ok("1")))?.message).toMatch(/wrong number of arguments/)
		expect(checkTypes(agg("topk", ok("3")))).toBeUndefined()
		expect(checkTypes(agg("sum", undefined))).toBeUndefined()
	})
})
