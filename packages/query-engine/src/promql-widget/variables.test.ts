import { describe, expect, it } from "vitest"
import type { VariableValues } from "../dashboard-variables/interpolate"
import { planWidgetRequest } from "../widget-request"
import { collectPromqlVariableRefs, interpolatePromqlBuiltins, interpolatePromqlVariables } from "./variables"

const one = (value: string) => ({ value, isAll: false, options: [value] })
const all = (options: string[]) => ({ value: "$__all", isAll: true, options })

const values: VariableValues = {
	service: one("checkout"),
	env: all(["prod", "staging"]),
	host: one("db-1.internal"),
}

describe("interpolatePromqlVariables", () => {
	it.each([
		['up{job="$service"}', 'up{job="checkout"}'],
		['up{job="${service}"}', 'up{job="checkout"}'],
		['up{job="[[service]]"}', 'up{job="checkout"}'],
	])("fills %s", (query, expected) => {
		expect(interpolatePromqlVariables(query, values)).toBe(expected)
	})

	it("regex-escapes a single value only under :regex", () => {
		expect(interpolatePromqlVariables('up{instance=~"${host:regex}"}', values)).toBe(
			'up{instance=~"db-1\\\\.internal"}',
		)
		expect(interpolatePromqlVariables('up{instance="$host"}', values)).toBe(
			'up{instance="db-1.internal"}',
		)
	})

	it("writes an All selection as a regex alternation", () => {
		expect(interpolatePromqlVariables('up{env=~"$env"}', values)).toBe('up{env=~"(prod|staging)"}')
		expect(interpolatePromqlVariables('up{env=~"[[env]]"}', values)).toBe('up{env=~"(prod|staging)"}')
	})

	it("escapes regex metacharacters and quotes inside each option", () => {
		const tricky: VariableValues = { path: all(["/a.b", 'x"y']) }
		expect(interpolatePromqlVariables('hits{path=~"$path"}', tricky)).toBe(
			'hits{path=~"(/a\\\\.b|x\\"y)"}',
		)
	})

	it("keeps a value inside its string literal", () => {
		const hostile: VariableValues = { service: one('a"} or vector(1) #') }
		expect(interpolatePromqlVariables('up{job="$service"}', hostile)).toBe(
			'up{job="a\\"} or vector(1) #"}',
		)
	})

	it("matches everything for an All with no options, and leaves unknown names literal", () => {
		expect(interpolatePromqlVariables('up{env=~"$env"}', { env: all([]) })).toBe('up{env=~".*"}')
		expect(interpolatePromqlVariables('up{job="$missing"}', values)).toBe('up{job="$missing"}')
	})

	it("leaves built-ins for the executor", () => {
		expect(interpolatePromqlVariables("rate(x[$__rate_interval])", values)).toBe(
			"rate(x[$__rate_interval])",
		)
	})

	it("collects every reference syntax", () => {
		expect(collectPromqlVariableRefs('a{x="$one", y="${two:regex}", z="[[three]]"} $__interval')).toEqual(
			["one", "two", "three"],
		)
	})
})

describe("interpolatePromqlBuiltins", () => {
	const hour = { startMs: 0, endMs: 3_600_000 }

	it("leaves a built-in inside a string literal, where a dashboard value put it", () => {
		expect(
			interpolatePromqlBuiltins('rate(x{a="$__interval"}[$__interval])', {
				startMs: 0,
				endMs: 3_600_000,
				stepMs: 30_000,
			}),
		).toBe('rate(x{a="$__interval"}[30s])')
	})

	it("fills interval, range and their forms", () => {
		const query = "x[$__interval] y[${__range}] $__range_s $__range_ms $__interval_ms"
		expect(interpolatePromqlBuiltins(query, { ...hour, stepMs: 30_000 })).toBe(
			"x[30s] y[3600s] 3600 3600000 30000",
		)
	})

	it("follows Grafana's rate interval rule", () => {
		// max(4 * 15s, step + 15s): a short step floors at 60s, a long one adds a scrape.
		expect(interpolatePromqlBuiltins("[$__rate_interval]", { ...hour, stepMs: 15_000 })).toBe("[60s]")
		expect(interpolatePromqlBuiltins("[$__rate_interval]", { ...hour, stepMs: 120_000 })).toBe("[135s]")
	})

	it("leaves an unknown built-in alone", () => {
		expect(interpolatePromqlBuiltins("$__intervalx $__foo", { ...hour, stepMs: 15_000 })).toBe(
			"$__intervalx $__foo",
		)
	})
})

describe("a promql widget request through the planner", () => {
	it("formats variables as PromQL and carries the tile width", () => {
		const plan = planWidgetRequest({
			request: {
				endpoint: "promql_chart",
				params: { promql: 'up{env=~"$env"}', legendFormat: "{{job}}" },
			},
			dashboardWindow: { startTime: "2026-01-01 00:00:00", endTime: "2026-01-01 01:00:00" },
			variableValues: values,
			maxDataPoints: 240,
		})
		expect(plan.kind === "request" && plan.params).toMatchObject({
			promql: 'up{env=~"(prod|staging)"}',
			legendFormat: "{{job}}",
			maxDataPoints: 240,
		})
	})
})

describe("variables cannot change a query's structure", () => {
	const hostile = (value: string): VariableValues => ({ v: one(value) })

	it("escapes for the quote a value sits in", () => {
		expect(interpolatePromqlVariables("up{a='$v'}", hostile("x'} or vector(1) or up{a='"))).toBe(
			"up{a='x\\'} or vector(1) or up{a=\\''}",
		)
		expect(interpolatePromqlVariables('up{a="$v"}', hostile('x"} or vector(1)'))).toBe(
			'up{a="x\\"} or vector(1)"}',
		)
	})

	it("refuses a backtick inside a raw string and an operator outside any string", () => {
		expect(interpolatePromqlVariables("up{a=`$v`}", hostile("x`} or vector(1) or up{a=`"))).toBe(
			"up{a=`$v`}",
		)
		expect(
			interpolatePromqlVariables("sum by ($v) (up)", hostile("job) (up) or vector(1) or sum by (job")),
		).toBe("sum by ($v) (up)")
		expect(interpolatePromqlVariables("rate(up[$v])", hostile("5m"))).toBe("rate(up[5m])")
	})

	it("never puts an All alternation outside a string", () => {
		expect(interpolatePromqlVariables("sum by ($v) (up)", { v: all(["a", "b"]) })).toBe(
			"sum by ($v) (up)",
		)
		expect(interpolatePromqlVariables("up{a=~'$v'}", { v: all(["a", "b'c"]) })).toBe("up{a=~'(a|b\\'c)'}")
	})

	it("reads a quote inside a # comment as comment text, not a string", () => {
		const query = '# John\'s panel\nup{job="$v"}'
		expect(interpolatePromqlVariables(query, { v: one('a"} or vector(1) #') })).toBe(
			'# John\'s panel\nup{job="a\\"} or vector(1) #"}',
		)
	})

	it("escapes a newline in a quoted value, single or All", () => {
		expect(interpolatePromqlVariables('up{a="$v"}', { v: one("x\ny") })).toBe('up{a="x\\ny"}')
		expect(interpolatePromqlVariables("up{a=~'$v'}", { v: all(["x\ny", "z"]) })).toBe(
			"up{a=~'(x\\ny|z)'}",
		)
	})

	it("leaves a name like an Object member literal", () => {
		expect(interpolatePromqlVariables('up{job="$constructor"}', {})).toBe('up{job="$constructor"}')
	})

	it("places only whole tokens outside strings", () => {
		expect(interpolatePromqlVariables("up * $v", { v: one("1-2") })).toBe("up * $v")
		expect(interpolatePromqlVariables("up * $v", { v: one("1.5e3") })).toBe("up * 1.5e3")
		expect(interpolatePromqlVariables("rate(x[$v])", { v: one("1m30s") })).toBe("rate(x[1m30s])")
		expect(interpolatePromqlVariables("sum by ($v) (up)", { v: one("host_name") })).toBe(
			"sum by (host_name) (up)",
		)
	})
})
