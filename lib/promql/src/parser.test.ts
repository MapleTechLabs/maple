import { Result } from "effect"
import { describe, expect, it } from "vitest"
import type { Expr } from "./ast"
import { parse } from "./parser"
import { print } from "./print"

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

	it("reads Prometheus 3 quoted metric and label names", () => {
		const expr = ok('{"http.server.duration", "service.name"="api"}')
		expect(expr).toMatchObject({
			type: "VectorSelector",
			name: "http.server.duration",
			matchers: [
				{ name: "__name__", op: "=", value: "http.server.duration" },
				{ name: "service.name", op: "=", value: "api" },
			],
		})
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
		expect(errorOf("sum(x) offset 5m")).toMatch(/selector or subquery/)
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
