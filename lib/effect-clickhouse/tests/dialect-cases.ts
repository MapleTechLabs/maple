// Fixtures use only public entry points, resolved through the package's built dist.
// Raw SQL supplies deterministic input rows; the operation under test uses the DSL.
import { DateTime } from "effect"
import * as CH from "@maple-dev/effect-clickhouse"
import * as F from "@maple-dev/effect-clickhouse/expr"
import * as T from "@maple-dev/effect-clickhouse/types"

export interface DialectCase {
	readonly metadata?: { readonly route: string; readonly tenantScope: CH.TenantScope }
	readonly format?: "JSON" | "JSONEachRow"
	readonly id: string
	readonly covers: readonly string[]
	readonly build: () => CH.CompiledQuery<any>
	readonly expected: readonly unknown[]
}
const one = CH.table("system.one", {})
const n = CH.table("input", { n: T.uint8 })
const numbers = () => CH.from(n).withCTE("input", "SELECT arrayJoin([toUInt8(1), 2, 3]) AS n")
const l = CH.lit
const scalar = (
	id: string,
	covers: readonly string[],
	select: () => Record<string, CH.Expr<any>>,
	expected: unknown,
): DialectCase => ({
	id,
	covers,
	build: () => CH.compileUnsafe(CH.from(one).select(select), {}),
	expected: [expected],
})
const fn = (...names: string[]) => names.map((name) => `function:${name}`)

export const dialectCases: readonly DialectCase[] = [
	scalar(
		"strings",
		fn(
			"toString_",
			"length_",
			"lower_",
			"positionCaseInsensitive",
			"left_",
			"position_",
			"replaceOne",
			"extract_",
			"match_",
			"concat",
			"hex",
		),
		() => ({
			text: CH.toString(l(42)),
			length: CH.length(l("hello")),
			lower: CH.lower(l("HELLO")),
			position: CH.position(l("hello"), "ll"),
			insensitive: CH.positionCaseInsensitive(l("Hello"), l("EL")),
			left: CH.left(l("hello"), l(2)),
			replaced: CH.replaceOne(l("banana"), "na", "NO"),
			extracted: CH.extract(l("item42"), "[0-9]+"),
			matched: CH.match(l("item42"), "[0-9]+"),
			concat: CH.concat(l("a"), "'", l("b")),
			hex: CH.hex(l("AB")),
		}),
		{
			text: "42",
			length: 5,
			lower: "hello",
			position: 3,
			insensitive: 2,
			left: "he",
			replaced: "baNOna",
			extracted: "42",
			matched: 1,
			concat: "a'b",
			hex: "4142",
		},
	),
	scalar(
		"urls",
		fn("domain_", "path_", "cutQueryString"),
		() => ({
			domain: CH.domain(l("https://example.com/a?b=1")),
			path: CH.path(l("https://example.com/a?b=1")),
			clean: CH.cutQueryString(l("https://example.com/a?b=1")),
			empty: CH.domain(l("")),
		}),
		{ domain: "example.com", path: "/a", clean: "https://example.com/a", empty: "" },
	),
	{
		id: "string-predicates",
		covers: fn("matchCond", "multiSearchAnyCaseInsensitive", "hasToken", "hasAllTokens"),
		build: () =>
			CH.compileUnsafe(
				CH.from(one)
					.select(() => ({ ok: l(1) }))
					.where(() => [
						CH.matchCond(l("hello world"), "^hello"),
						F.multiSearchAnyCaseInsensitive(l("Hello"), ["EL", "absent"]),
						CH.hasToken(l("hello world"), "hello"),
						CH.hasAllTokens(l("hello world"), "world hello"),
					]),
				{},
			),
		expected: [{ ok: 1 }],
	},
	scalar(
		"numeric",
		fn(
			"round_",
			"intDiv",
			"toFloat64OrZero",
			"toFloat64",
			"toUInt16OrZero",
			"toUInt64",
			"toInt64",
			"least_",
			"greatest_",
			"cityHash64",
		),
		() => ({
			round: CH.round(l(1.234), 2),
			div: CH.intDiv(l(7), 2),
			invalid: CH.toFloat64OrZero(l("bad")),
			float: CH.toFloat64(l(3)),
			uint16: CH.toUInt16OrZero(l("bad")),
			uint64: CH.toUInt64(l("42")),
			int64: CH.toInt64(l(-42)),
			least: CH.least(l(3), l(2)),
			greatest: CH.greatest(l(3), l(2)),
			hash: CH.toString(CH.cityHash64(l(""))),
			// Chaining deliberately follows SQL operator precedence (documented in expressions.md).
			arithmetic: l(10).add(2).mul(3).sub(6).div(2).mod(4),
		}),
		{
			round: 1.23,
			div: 3,
			invalid: 0,
			float: 3,
			uint16: 0,
			uint64: 42,
			int64: -42,
			least: 2,
			greatest: 3,
			hash: "11160318154034397263",
			arithmetic: 13,
		},
	),
	scalar(
		"conditionals",
		fn("if_", "multiIf", "coalesce", "ifNull", "nullIf", "ifNotFinite"),
		() => ({
			branch: CH.if_(l(1).eq(1), l("yes"), l("no")),
			multi: CH.multiIf(
				[
					[l(1).eq(2), l("no")],
					[l(1).eq(1), l("yes")],
				],
				l("fallback"),
			),
			coalesced: CH.coalesce(CH.nullIf(l(1), 1), l(2)),
			fallback: CH.ifNull(CH.nullIf(l(1), 1), l(3)),
			null: CH.nullIf(l("x"), "x"),
			finite: CH.ifNotFinite(l(1).div(0), 7),
			leastNull: CH.least(CH.nullIf(l(1), 1), l(2)),
			greatestNull: CH.greatest(CH.nullIf(l(1), 1), l(2)),
		}),
		{
			branch: "yes",
			multi: "yes",
			coalesced: 2,
			fallback: 3,
			null: null,
			finite: 7,
			leastNull: 2,
			greatestNull: 2,
		},
	),
	scalar(
		"arrays",
		fn(
			"arrayOf",
			"arrayStringConcat",
			"arrayFilter",
			"arrayDistinct",
			"arrayElement",
			"arrayPushFront",
			"arrayReverseSort",
			"arraySort",
		),
		() => {
			const a = CH.arrayOf(l(3), l(1), l(3))
			return {
				sorted: CH.arraySort(a),
				reversed: CH.arrayReverseSort(a),
				distinct: CH.arrayDistinct(a),
				filtered: CH.arrayFilter("x -> x > 1", a),
				front: CH.arrayPushFront(a, l(0)),
				first: CH.arrayElement(a, 1),
				missing: CH.arrayElement(a, 9),
				joined: CH.arrayStringConcat(CH.arrayOf(l("a"), l("b")), "'"),
				joinedList: CH.arrayStringConcat([l("a"), l("b")], ","),
			}
		},
		{
			sorted: [1, 3, 3],
			reversed: [3, 3, 1],
			distinct: [3, 1],
			filtered: [3, 3],
			front: [0, 3, 1, 3],
			first: 3,
			missing: 0,
			joined: "a'b",
			joinedList: "a,b",
		},
	),
	{
		id: "array-join-and-membership",
		covers: fn("arrayJoin", "has"),
		build: () =>
			CH.compileUnsafe(
				CH.from(one)
					.select(() => ({ value: CH.arrayJoin(CH.arrayOf(l(1), l(2))) }))
					.where(() => [CH.has(CH.arrayOf(l(1), l(2)), 2)])
					.orderBy(["value", "asc"]),
				{},
			),
		expected: [{ value: 1 }, { value: 2 }],
	},
	scalar(
		"maps-and-json",
		fn("mapLiteral", "mapGet", "mapKeys", "mapValues", "toJSONString"),
		() => {
			const map = CH.mapLiteral(["a'b", l("v")])
			return {
				map,
				value: CH.mapGet(map, "a'b"),
				missing: CH.mapGet(map, "missing"),
				keys: CH.mapKeys(map),
				values: CH.mapValues(map),
				json: CH.toJSONString(map),
			}
		},
		{ map: { "a'b": "v" }, value: "v", missing: "", keys: ["a'b"], values: ["v"], json: '{"a\'b":"v"}' },
	),
	{
		id: "map-membership",
		covers: fn("mapContains"),
		build: () =>
			CH.compileUnsafe(
				CH.from(one)
					.select(() => ({ ok: l(1) }))
					.where(() => [CH.mapContains(CH.mapLiteral(["a", l("v")]), "a")]),
				{},
			),
		expected: [{ ok: 1 }],
	},
	{
		id: "aggregates",
		covers: fn(
			"count",
			"countIf",
			"avg",
			"sum",
			"min_",
			"max_",
			"any_",
			"anyIf",
			"uniq",
			"uniqIf",
			"uniqExact",
			"sumIf",
			"avgIf",
			"maxIf",
			"minIf",
			"quantile",
			"groupUniqArray",
			"groupUniqArrayArray",
			"groupUniqArrayIf",
			"argMin",
			"argMax",
		),
		build: () =>
			CH.compileUnsafe(
				numbers().select(($) => ({
					count: CH.count(),
					countIf: CH.countIf($.n.gt(1)),
					avg: CH.avg($.n),
					sum: CH.sum($.n),
					min: CH.min($.n),
					max: CH.max($.n),
					any: CH.any(l("constant")),
					anyIf: CH.anyIf($.n, $.n.eq(2)),
					uniq: CH.uniq($.n),
					uniqIf: CH.uniqIf($.n, $.n.gt(1)),
					exact: CH.uniqExact($.n),
					sumIf: CH.sumIf($.n, $.n.gt(1)),
					avgIf: CH.avgIf($.n, $.n.gt(1)),
					maxIf: CH.maxIf($.n, $.n.gt(1)),
					minIf: CH.minIf($.n, $.n.gt(1)),
					quantile: CH.quantile(0.5)($.n),
					values: CH.arraySort(CH.groupUniqArray($.n)),
					arrays: CH.arraySort(CH.groupUniqArrayArray(CH.arrayOf($.n))),
					limited: CH.arraySort(CH.groupUniqArrayIf(5)($.n, $.n.gt(1))),
					argMin: CH.argMin($.n, $.n),
					argMax: CH.argMax($.n, $.n),
				})),
				{},
			),
		expected: [
			{
				count: 3,
				countIf: 2,
				avg: 2,
				sum: 6,
				min: 1,
				max: 3,
				any: "constant",
				anyIf: 2,
				uniq: 3,
				uniqIf: 2,
				exact: 3,
				sumIf: 5,
				avgIf: 2.5,
				maxIf: 3,
				minIf: 2,
				quantile: 2,
				values: [1, 2, 3],
				arrays: [1, 2, 3],
				limited: [2, 3],
				argMin: 1,
				argMax: 3,
			},
		],
	},
	{
		id: "aggregate-state-merge",
		covers: [...fn("argMaxMerge"), "type:aggregateState"],
		build: () => {
			const states = CH.table("states", { state: T.aggregateState("argMax", "String", "UInt8") })
			return CH.compileUnsafe(
				CH.from(states)
					.withCTE(
						"states",
						"SELECT argMaxState(toString(number), toUInt8(number)) AS state FROM numbers(3)",
					)
					.select(($) => ({ value: CH.argMaxMerge($.state) })),
				{},
			)
		},
		expected: [{ value: "2" }],
	},
	{
		id: "event-sequences",
		covers: fn("windowFunnel", "sequenceMatch"),
		build: () =>
			CH.compileUnsafe(
				numbers().select(($) => ({
					strictFunnel: CH.windowFunnel(10, "strict_order")(CH.toUInt64($.n), $.n.eq(1), $.n.eq(3)),
					funnel: CH.windowFunnel(10)(CH.toUInt64($.n), $.n.eq(1), $.n.eq(3)),
					sequence: CH.sequenceMatch("(?1).*(?2)")(CH.toUInt64($.n), $.n.eq(1), $.n.eq(3)),
				})),
				{},
			),
		expected: [{ strictFunnel: 1, funnel: 2, sequence: 1 }],
	},
	scalar(
		"date-functions",
		fn(
			"toStartOfInterval",
			"toStartOfHour",
			"toStartOfMinute",
			"toHour",
			"toUnixTimestamp",
			"toUnixTimestamp64Nano",
			"intervalAdd",
			"intervalSub",
			"formatDateTime",
			"toDateTime",
		),
		() => {
			const time = CH.toDateTime(l("2026-01-02 03:04:05"))
			return {
				bucket: CH.toStartOfInterval(time, 300),
				hour: CH.toStartOfHour(time),
				minute: CH.toStartOfMinute(time),
				hourNumber: CH.toHour(time),
				seconds: CH.toUnixTimestamp(CH.toDateTime(l(42))),
				nanos: CH.toUnixTimestamp64Nano(
					CH.rawExpr("toDateTime64('1970-01-01 00:00:01.123', 3, 'UTC')", T.dateTime64),
				),
				added: CH.intervalAdd(time, 60),
				subtracted: CH.intervalSub(time, 60),
				formatted: CH.formatDateTime(time, "%Y-%m-%d"),
			}
		},
		{
			bucket: "2026-01-02 03:00:00",
			hour: "2026-01-02 03:00:00",
			minute: "2026-01-02 03:04:00",
			hourNumber: 3,
			seconds: 42,
			nanos: 1123000000,
			added: "2026-01-02 03:05:05",
			subtracted: "2026-01-02 03:03:05",
			formatted: "2026-01-02",
		},
	),
	{
		id: "window-over-grouped-subquery",
		covers: [
			...fn(
				"windowSpec",
				"rowsBetween",
				"unboundedPreceding",
				"currentRow",
				"over",
				"lagInFrame",
				"preceding",
				"following",
				"unboundedFollowing",
			),
			"query:groupBy",
			"query:having",
		],
		build: () => {
			const grouped = numbers()
				.select(($) => ({ key: $.n, total: CH.sum($.n) }))
				.groupBy("key")
				.having(() => [CH.dynamicColumn<number>("total").gt(0)])
			return CH.compileUnsafe(
				CH.fromQuery(grouped, "g")
					.select(($) => ({
						key: $.key,
						running: CH.over(
							CH.sum($.total),
							CH.windowSpec({
								orderBy: [[$.key, "asc"]],
								frame: CH.rowsBetween(CH.unboundedPreceding, CH.currentRow),
							}),
						),
						previous: CH.over(
							CH.lagInFrame($.total, 1, 0),
							CH.windowSpec({
								orderBy: [[$.key, "asc"]],
								frame: CH.rowsBetween(CH.preceding(1), CH.following(1)),
							}),
						),
						all: CH.over(
							CH.sum($.total),
							CH.windowSpec({
								partitionBy: [l(1)],
								frame: CH.rowsBetween(CH.unboundedPreceding, CH.unboundedFollowing),
							}),
						),
					}))
					.orderBy(["key", "asc"]),
				{},
			)
		},
		expected: [
			{ key: 1, running: 1, previous: 0, all: 6 },
			{ key: 2, running: 3, previous: 1, all: 6 },
			{ key: 3, running: 6, previous: 2, all: 6 },
		],
	},
	{
		id: "query-pagination",
		metadata: { route: "test", tenantScope: "cross-tenant" },
		covers: [
			"query:select",
			"query:where",
			"query:orderBy",
			"query:limit",
			"query:offset",
			"query:withCTE",
			"query:format",
			"query:route",
			"query:crossTenant",
		],
		build: () =>
			CH.compileUnsafe(
				numbers()
					.select("n")
					.where(($) => [$.n.gte(CH.param.int("minimum"))])
					.orderBy(["n", "desc"])
					.limit(1)
					.offset(1)
					.format("JSONEachRow")
					.route("test")
					.crossTenant(),
				{ minimum: 1 },
			),
		expected: [{ n: 2 }],
	},
	...(["innerJoin", "leftJoin", "crossJoin"] as const).map(
		(method): DialectCase => ({
			id: `direct-${method}`,
			covers: [`query:${method}`],
			build: () => {
				const a = CH.table("a", { id: T.uint8 }),
					b = CH.table("b", { id: T.uint8, name: T.string })
				const base = CH.from(a)
					.withCTE("a", "SELECT toUInt8(1) AS id")
					.withCTE("b", "SELECT toUInt8(1) AS id, 'match' AS name")
				const select = ($: { id: CH.Expr<number>; b: { name: CH.Expr<string | null> } }) => ({
					id: $.id,
					name: $.b.name,
				})
				if (method === "crossJoin") return CH.compileUnsafe(base.crossJoin(b, "b").select(select), {})
				if (method === "leftJoin")
					return CH.compileUnsafe(base.leftJoin(b, "b", (a, b) => a.id.eq(b.id)).select(select), {})
				return CH.compileUnsafe(base.innerJoin(b, "b", (a, b) => a.id.eq(b.id)).select(select), {})
			},
			expected: [{ id: 1, name: "match" }],
		}),
	),
	...(["innerJoinQuery", "leftJoinQuery", "crossJoinQuery"] as const).map(
		(method): DialectCase => ({
			id: `derived-${method}`,
			covers: [`query:${method}`],
			build: () => {
				const a = CH.from(one).select(() => ({ id: l(1) })),
					b = CH.from(one).select(() => ({ id: l(1), name: CH.nullIf(l("null"), "null") }))
				const nullableUnion = CH.fromUnion(CH.unionAll(b, b), "u").select("id", "name")
				const base = CH.fromQuery(a, "a")
				const select = ($: { id: CH.Expr<number>; b: { name: CH.Expr<string | null> } }) => ({
					id: $.id,
					name: $.b.name,
				})
				if (method === "crossJoinQuery")
					return CH.compileUnsafe(base.crossJoinQuery(nullableUnion, "b").select(select), {})
				if (method === "leftJoinQuery")
					return CH.compileUnsafe(
						base.leftJoinQuery(nullableUnion, "b", (a, b) => a.id.eq(b.id)).select(select),
						{},
					)
				return CH.compileUnsafe(
					base.innerJoinQuery(nullableUnion, "b", (a, b) => a.id.eq(b.id)).select(select),
					{},
				)
			},
			expected: [
				{ id: 1, name: null },
				{ id: 1, name: null },
			],
		}),
	),
	{
		id: "union-pagination",
		covers: ["union:orderBy", "union:limit", "union:offset", "union:format"],
		build: () =>
			CH.compileUnionUnsafe(
				CH.unionAll(
					CH.from(one).select(() => ({ n: l(1) })),
					CH.from(one).select(() => ({ n: l(2) })),
				)
					.orderBy(["n", "desc"])
					.limit(1)
					.offset(1)
					.format("JSONEachRow"),
				{},
			),
		expected: [{ n: 1 }],
	},
	{
		id: "subquery-parameters",
		covers: [],
		build: () => {
			const inner = numbers()
				.select("n")
				.where(($) => [$.n.eq(CH.param.int("wanted"))])
			return CH.compileUnsafe(
				numbers()
					.select("n")
					.where(($) => [
						CH.inSubquery($.n, inner),
						CH.exists(inner),
						CH.notInSubquery($.n, "SELECT 99"),
					]),
				{ wanted: 2 },
			)
		},
		expected: [{ n: 2 }],
	},
	{
		id: "json-query-format",
		covers: [],
		format: "JSON",
		build: () => CH.compileUnsafe(numbers().select("n").orderBy(["n", "asc"]).format("JSON"), {}),
		expected: [{ n: 1 }, { n: 2 }, { n: 3 }],
	},
	{
		id: "json-union-format",
		covers: [],
		format: "JSON",
		build: () =>
			CH.compileUnionUnsafe(
				CH.unionAll(
					CH.from(one).select(() => ({ n: l(1) })),
					CH.from(one).select(() => ({ n: l(2) })),
				)
					.orderBy(["n", "asc"])
					.format("JSON"),
				{},
			),
		expected: [{ n: 1 }, { n: 2 }],
	},
	scalar(
		"uint64-identity-as-string",
		[],
		() => ({ id: CH.toString(CH.toUInt64(l("18446744073709551615"))) }),
		{ id: "18446744073709551615" },
	),
	{
		id: "structured-parameters-and-literals",
		covers: [],
		build: () => {
			const rows = CH.table("structured", {
				tags: T.array(T.string),
				attrs: T.map(T.string, T.string),
				enabled: T.bool,
			})
			return CH.compileUnsafe(
				CH.from(rows)
					.withCTE(
						"structured",
						"SELECT ['a', 'b'] AS tags, map('key', 'value') AS attrs, true AS enabled",
					)
					.select("tags", "attrs", "enabled")
					.where(($) => [
						$.tags.eq(CH.param.of(T.array(T.string), "tags")),
						$.attrs.eq({ key: "value" }),
						$.enabled.eq(CH.param.bool("enabled")),
					]),
				{ tags: ["a", "b"], enabled: true },
			)
		},
		expected: [{ tags: ["a", "b"], attrs: { key: "value" }, enabled: true }],
	},
	{
		id: "empty-input-aggregates",
		covers: [],
		build: () =>
			CH.compileUnsafe(
				numbers()
					.where(($) => [$.n.eq(0)])
					.select(($) => ({
						count: CH.count(),
						sum: CH.sum($.n),
						avg: CH.avg($.n),
						quantile: CH.quantile(0.5)($.n),
						array: CH.groupUniqArray($.n),
					})),
				{},
			),
		expected: [{ count: 0, sum: 0, avg: null, quantile: null, array: [] }],
	},
	scalar(
		"empty-arrays-and-maps",
		[],
		() => ({
			array: CH.arrayFilter("x -> x > 9", CH.arrayOf(l(1))),
			map: CH.mapLiteral(),
			missing: CH.arrayElement(
				CH.rawExpr("CAST([] AS Array(Nullable(UInt8)))", T.array(T.nullable(T.uint8))),
				1,
			),
		}),
		{ array: [], map: {}, missing: null },
	),

	...(["", "' OR 1=1 --", "\\\n\r\t\0", "__PARAM_String_secret__", "🍁 café"] as const).map(
		(value, i): DialectCase => ({
			id: `literal-param-roundtrip-${i}`,
			covers: [],
			build: () =>
				CH.compileUnsafe(
					CH.from(one).select(() => ({ literal: l(value), parameter: CH.param.string("value") })),
					{ value },
				),
			expected: [{ literal: value, parameter: value }],
		}),
	),
]

// Each descriptor is exercised on a real typed column, including compound wire values.
const typeFixtures = [
	["string", T.string, "'hello'", "hello"],
	["uint8", T.uint8, "toUInt8(255)", 255],
	["uint16", T.uint16, "toUInt16(65535)", 65535],
	["uint32", T.uint32, "toUInt32(4294967295)", 4294967295],
	["uint64", T.uint64, "toUInt64(9007199254740991)", 9007199254740991],
	["int32", T.int32, "toInt32(-2147483648)", -2147483648],
	["int64", T.int64, "toInt64(-9007199254740991)", -9007199254740991],
	["float64", T.float64, "toFloat64(1.25)", 1.25],
	["bool", T.bool, "true", true],
	[
		"dateTime",
		T.dateTime,
		"toDateTime('2026-01-01 00:00:00', 'UTC')",
		DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
	],
	[
		"dateTime64",
		T.dateTime64,
		"toDateTime64('2026-01-01 00:00:00.123', 3, 'UTC')",
		DateTime.makeUnsafe("2026-01-01T00:00:00.123Z"),
	],
	["dateTimeString", T.dateTimeString, "toDateTime('2026-01-01 00:00:00', 'UTC')", "2026-01-01 00:00:00"],
	[
		"dateTime64String",
		T.dateTime64String,
		"toDateTime64('2026-01-01 00:00:00.123', 3, 'UTC')",
		"2026-01-01 00:00:00.123",
	],
	["array", T.array(T.nullable(T.int64)), "[toNullable(toInt64(42)), NULL]", [42, null]],
	["map", T.map(T.string, T.array(T.uint64)), "map('key', [toUInt64(42)])", { key: [42] }],
	["nullable", T.nullable(T.string), "CAST(NULL AS Nullable(String))", null],
] as const

export const typeCases: readonly DialectCase[] = typeFixtures.map(([name, type, sql, expected]) => ({
	id: `type-${name}`,
	covers: [`type:${name}`],
	build: () =>
		CH.compileUnsafe(
			CH.from(CH.table("typed", { value: type }))
				.withCTE("typed", `SELECT ${sql} AS value`)
				.select("value"),
			{},
		),
	expected: [{ value: expected }],
}))
