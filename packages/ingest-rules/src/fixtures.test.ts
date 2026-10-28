import { IngestRuleSpec } from "@maple/domain/ingest-rules"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import dropCases from "../fixtures/drop.json" with { type: "json" }
import redactCases from "../fixtures/redact.json" with { type: "json" }
import { applyRules, compileRules, isAttrList, type AttrMap, type AttrValue, type RuleRecord } from "./engine"

// The same fixtures run in `cargo test` against apps/ingest/src/ingest_rules.rs.

const decodeSpecs = Schema.decodeUnknownSync(Schema.Array(IngestRuleSpec))
const FixtureRecord = Schema.Struct({
	signal: Schema.Literals(["traces", "logs", "metrics"]),
	resource: Schema.Record(Schema.String, Schema.Unknown),
	attributes: Schema.Record(Schema.String, Schema.Unknown),
	name: Schema.optionalKey(Schema.String),
	body: Schema.optionalKey(Schema.Unknown),
	severityNumber: Schema.optionalKey(Schema.Number),
	severityText: Schema.optionalKey(Schema.String),
	traceId: Schema.optionalKey(Schema.String),
	spanKind: Schema.optionalKey(Schema.String),
	spanStatus: Schema.optionalKey(Schema.String),
	statusMessage: Schema.optionalKey(Schema.String),
	events: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({ name: Schema.String, attributes: Schema.Record(Schema.String, Schema.Unknown) }),
		),
	),
})
const decodeRecord = Schema.decodeUnknownSync(FixtureRecord)

const BytesMarker = Schema.Struct({ $bytes: Schema.String })
const isBytesMarker = Schema.is(BytesMarker)

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const toValue = (json: unknown): AttrValue => {
	if (typeof json === "string" || typeof json === "number" || typeof json === "boolean") return json
	if (Array.isArray(json)) return json.map(toValue)
	if (isBytesMarker(json)) return fromHex(json.$bytes)
	return toMap(json)
}
const toMap = (json: unknown): AttrMap =>
	typeof json === "object" && json !== null
		? Object.fromEntries(Object.entries(json).map(([k, v]) => [k, toValue(v)]))
		: {}

type Json = string | number | bigint | boolean | ReadonlyArray<Json> | { readonly [key: string]: Json }

const toJson = (value: AttrValue): Json => {
	if (value instanceof Uint8Array) return { $bytes: toHex(value) }
	if (isAttrList(value)) return value.map(toJson)
	if (typeof value === "object") return mapJson(value)
	return value
}
const mapJson = (map: AttrMap): Json =>
	Object.fromEntries(Object.entries(map).map(([k, v]) => [k, toJson(v)]))
const eventsJson = (record: RuleRecord) =>
	record.events?.map((event) => ({ name: event.name, attributes: mapJson(event.attributes) }))

const toRecord = (input: unknown): RuleRecord => {
	const fixture = decodeRecord(input)
	return {
		signal: fixture.signal,
		resource: toMap(fixture.resource),
		attributes: toMap(fixture.attributes),
		name: fixture.name,
		body: fixture.body === undefined ? undefined : toValue(fixture.body),
		severityNumber: fixture.severityNumber,
		severityText: fixture.severityText,
		traceId: fixture.traceId,
		spanKind: fixture.spanKind,
		spanStatus: fixture.spanStatus,
		statusMessage: fixture.statusMessage,
		events: fixture.events?.map((event) => ({ name: event.name, attributes: toMap(event.attributes) })),
	}
}

/** The kept record in the fixture's `expected` form; absent body and events are left out. */
const outcomeJson = (record: RuleRecord) =>
	Object.fromEntries(
		Object.entries({
			dropped: false,
			resource: mapJson(record.resource),
			attributes: mapJson(record.attributes),
			body: record.body === undefined ? undefined : toJson(record.body),
			events: eventsJson(record),
			statusMessage: record.statusMessage,
		}).filter(([, value]) => value !== undefined),
	)

const suites = { drop: dropCases, redact: redactCases }

describe.each(Object.entries(suites))("%s fixtures", (_, cases) => {
	it.each(cases.map((fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
		const compiled = compileRules(decodeSpecs(fixture.rules), fixture.salt)
		expect(compiled.invalid).toEqual([])
		const outcome = applyRules(compiled, toRecord(fixture.input), () => 0.5)
		expect(outcome._tag === "dropped" ? { dropped: true } : outcomeJson(outcome.record)).toEqual(
			fixture.expected,
		)
	})
})
