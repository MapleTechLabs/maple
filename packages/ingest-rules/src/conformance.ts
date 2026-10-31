import { IngestRuleSpec } from "@maple/domain/ingest-rules"
import { Schema } from "effect"
import { applyRules, compileRules, isAttrList, type AttrMap, type AttrValue, type RuleRecord } from "./engine"

// One shared-fixture case and its outcome in the JSON form both engines agree on. The fixture
// tests, the invariant tests and the differential fuzzer (scripts/fuzz.ts) all run cases here;
// `cargo test` and the `ingest_rules_oracle` example do the same in apps/ingest.

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

type Json = Schema.Json

/** A fixture case; `expected` is absent on generated cases until an engine fills it in. */
export interface FixtureCase {
	readonly name: string
	readonly salt: string
	readonly rules: ReadonlyArray<unknown>
	readonly input: { readonly [key: string]: unknown }
	readonly expected?: unknown
}

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

const toJson = (value: AttrValue): Json => {
	if (typeof value === "bigint") return Number(value)
	if (value instanceof Uint8Array) return { $bytes: toHex(value) }
	if (isAttrList(value)) return value.map(toJson)
	if (typeof value === "object") return mapJson(value)
	return value
}
const mapJson = (map: AttrMap): Json =>
	Object.fromEntries(Object.entries(map).map(([k, v]) => [k, toJson(v)]))
const eventsJson = (record: RuleRecord) =>
	record.events?.map((event) => ({ name: event.name, attributes: mapJson(event.attributes) }))

export const toRecord = (input: unknown): RuleRecord => {
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

/** The entries whose value is present, as a JSON object. */
export const present = (entries: ReadonlyArray<readonly [string, Json | undefined]>): Schema.JsonObject =>
	Object.fromEntries(entries.flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])))

export const isJsonObject = (value: Json | undefined): value is Schema.JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** A member of a JSON object; undefined for anything else. */
export const member = (value: Json | undefined, key: string): Json | undefined =>
	isJsonObject(value) ? value[key] : undefined

/** The kept record in the fixture's `expected` form; absent body and events are left out. */
export const outcomeJson = (record: RuleRecord): Schema.JsonObject =>
	present([
		["dropped", false],
		["resource", mapJson(record.resource)],
		["attributes", mapJson(record.attributes)],
		["body", record.body === undefined ? undefined : toJson(record.body)],
		["events", eventsJson(record)],
		["statusMessage", record.statusMessage],
	])

/**
 * The case's outcome as the gateway would report it. Records without a trace id draw 0.5, so
 * cases that sample them are only portable at keep 0 or 100.
 */
export const runCase = (fixture: FixtureCase): Json => {
	const compiled = compileRules(decodeSpecs(fixture.rules), fixture.salt)
	if (compiled.invalid.length > 0)
		return { invalid: compiled.invalid.map((rule) => ({ index: rule.index, problems: rule.problems })) }
	const outcome = applyRules(compiled, toRecord(fixture.input), () => 0.5)
	return outcome._tag === "dropped" ? { dropped: true } : outcomeJson(outcome.record)
}
