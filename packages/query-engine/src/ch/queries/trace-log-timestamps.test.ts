import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Schema, SchemaAST } from "effect"
import { compile, from, type CompiledQuery } from "@maple-dev/effect-orm/clickhouse"
import type { QueryBuilderError } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	errorDetailTracesQuery,
	spanDetailQuery,
	spanHierarchyQuery,
	traceTimeProbeQuery,
} from "./errors"
import { getLogByKeyQuery, logsListQuery, logsTimeseriesQuery } from "./logs"
import { sessionTraceSummariesQuery } from "./session-replays"
import { Traces, orgIdParam } from "../tables"
import {
	slowTracesQuery,
	spanSearchQuery,
	traceListQuery,
	traceSummariesQuery,
	tracesListQuery,
	tracesRootListQuery,
	tracesTimeseriesQuery,
} from "./traces"

// Rows reach callers through `decodeRows`. A query whose row schema is not
// derived passes rows through untouched, and its timestamps would stay strings
// behind a `DateTime.Utc` type.
const params = {
	orgId: OrgId.make("org_1"),
	startTime: DateTime.makeUnsafe("2024-01-01T00:00:00Z"),
	endTime: DateTime.makeUnsafe("2024-01-02T00:00:00Z"),
	timestamp: "2024-01-01 10:00:00.123456789",
	bucketSeconds: 60,
}

/** One selected field's codec, read off the derived row schema. */
const fieldCodec = (ast: SchemaAST.AST, field: string) => {
	const property = SchemaAST.isObjects(ast)
		? ast.propertySignatures.find((signature) => signature.name === field)
		: undefined
	return property && Schema.make<Schema.Codec<unknown, unknown, never, never>>(property.type)
}

const decodesUtc = <Output>(
	query: Effect.Effect<CompiledQuery<Output>, QueryBuilderError>,
	fields: ReadonlyArray<keyof Output & string>,
) =>
	Effect.gen(function* () {
		const compiled = yield* query
		expect(compiled.rowSchemaSource).toBe("derived")
		const ast = compiled.rowSchema?.ast
		if (ast === undefined) return expect.fail("expected a derived row schema")
		yield* Effect.forEach(fields, (field) =>
			Effect.gen(function* () {
				const codec = fieldCodec(ast, field)
				if (codec === undefined) return expect.fail(`no codec for ${field}`)
				const value = yield* Schema.decodeUnknownEffect(codec)("2024-01-01 10:00:00.123456789")
				expect(DateTime.isDateTime(value) ? DateTime.formatIso(value) : value).toBe(
					"2024-01-01T10:00:00.123Z",
				)
			}),
		)
	})

describe("trace and log rows decode timestamps to DateTime.Utc", () => {
	it.effect("traces lists", () =>
		Effect.gen(function* () {
			yield* decodesUtc(compile(tracesListQuery({}), params), ["timestamp"])
			yield* decodesUtc(compile(tracesRootListQuery({}), params), ["startTime", "endTime"])
			yield* decodesUtc(compile(traceListQuery({}), params), ["startTime", "endTime"])
			yield* decodesUtc(compile(spanSearchQuery({}), params), ["timestamp"])
			yield* decodesUtc(compile(spanSearchQuery({ traceId: "t1" }), params), ["timestamp"])
		}),
	)

	it.effect("trace_list_mv reads (DateTime, whole seconds)", () =>
		Effect.gen(function* () {
			const compiled = yield* compile(slowTracesQuery({}), params)
			expect(compiled.rowSchemaSource).toBe("derived")
			const [row] = yield* compiled.decodeRows([
				{
					traceId: "t1",
					spanName: "GET /",
					serviceName: "api",
					durationMs: 1,
					statusCode: "Ok",
					timestamp: "2024-01-01 10:00:00",
				},
			])
			expect(DateTime.formatIso(row!.timestamp)).toBe("2024-01-01T10:00:00.000Z")
			yield* decodesUtc(compile(traceSummariesQuery({}), params), ["startTime"])
		}),
	)

	it.effect("trace detail reads", () =>
		Effect.gen(function* () {
			yield* decodesUtc(compile(spanHierarchyQuery({ traceId: "t1" }), params), ["startTime"])
			yield* decodesUtc(compile(spanDetailQuery({ traceId: "t1", spanId: "s1" }), params), ["startTime"])
			yield* decodesUtc(compile(traceTimeProbeQuery({ traceId: "t1" }), params), ["timestamp"])
			// The error_events side still takes string bounds.
			const stringBounds = { ...params, startTime: "2024-01-01 00:00:00", endTime: "2024-01-02 00:00:00" }
			yield* decodesUtc(compile(errorDetailTracesQuery({ fingerprintHash: "1" }), stringBounds), [
				"startTime",
			])
			yield* decodesUtc(compile(sessionTraceSummariesQuery({ traceIds: ["t1"] }), params), ["startTime"])
		}),
	)

	it.effect("raw-table timeseries buckets", () =>
		Effect.gen(function* () {
			yield* decodesUtc(
				compile(
					tracesTimeseriesQuery({
						metric: "count",
						needsSampling: false,
						attributeFilters: [{ key: "user.id", value: "u1", mode: "equals" }],
					}),
					params,
				),
				["bucket"],
			)
			yield* decodesUtc(compile(logsTimeseriesQuery({ search: "boom" }), params), ["bucket"])
		}),
	)

	it.effect("logs", () =>
		Effect.gen(function* () {
			yield* decodesUtc(compile(logsListQuery({}), params), ["timestamp"])
			yield* decodesUtc(compile(getLogByKeyQuery({}), params), ["timestamp"])
		}),
	)

	it.effect("decodes span event timestamps inside the array column", () =>
		Effect.gen(function* () {
			const compiled = yield* compile(
				from(Traces)
					.select(($) => ({ events: $.EventsTimestamp }))
					.where(($) => [$.OrgId.eq(orgIdParam)]),
				params,
			)
			expect(compiled.rowSchemaSource).toBe("derived")
			const [row] = yield* compiled.decodeRows([
				{ events: ["2024-01-01 10:00:00.5", "2024-01-01 10:00:01.123456789"] },
			])
			expect(row!.events.map(DateTime.formatIso)).toEqual([
				"2024-01-01T10:00:00.500Z",
				"2024-01-01T10:00:01.123Z",
			])
		}),
	)
})
