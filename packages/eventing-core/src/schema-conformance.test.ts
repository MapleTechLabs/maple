import { readFileSync } from "node:fs"
import Ajv2020 from "ajv/dist/2020.js"
import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	MapleCloudEventSchema,
	SignalLiteralSchema,
	SignalPredicateSchema,
	SignalProjectionSpecSchema,
	SignalScalarSchema,
	timestampToEpochNanos,
	validateMapleCloudEvent,
	validateSignalScalar,
	type SignalPredicate,
} from "./index"
import { predicateInputBudgetIssue } from "./input-budget"

const readArtifact = (name: string): Record<string, unknown> =>
	Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
		JSON.parse(readFileSync(new URL(`../schemas/${name}.v1.schema.json`, import.meta.url), "utf8")),
	)
// Deliberately no format plugin: assertions must work in ordinary Draft 2020-12 validators.
const ajv = new Ajv2020({ strict: false })
const scalarJson = ajv.compile(readArtifact("signal-scalar"))
const projectionArtifact = readArtifact("signal-projection")
const projectionJson = ajv.compile(projectionArtifact)
const eventJson = ajv.compile(readArtifact("cloud-event"))
const leaf: SignalPredicate = {
	op: "exists",
	field: { namespace: "attribute", key: "message", type: "string" },
}
const projection = (selector: SignalPredicate = leaf, activeFrom = "2026-09-13T00:00:00Z") => ({
	id: "projection-a",
	revision: 1,
	enabled: true,
	tenantId: "tenant-a",
	sourceKind: "otel.log",
	selector,
	projector: { id: "projector-a", version: 1, config: {} },
	activeFrom,
})
const event = (time: string) => ({
	specversion: "1.0",
	id: "event-a",
	source: "urn:maple:test",
	type: "test.observed",
	time,
	datacontenttype: "application/json",
	dataschema: "urn:maple:test:v1",
	tenantid: "tenant-a",
	projectionid: "projection-a",
	projectionrevision: 1,
	projectorid: "projector-a",
	projectorversion: 1,
	data: {},
})

const checkTimestamp = (value: string, valid: boolean): void => {
	const scalar = { type: "timestamp" as const, value }
	expect(scalarJson(scalar), value).toBe(valid)
	expect(Result.isSuccess(Schema.decodeUnknownResult(SignalScalarSchema)(scalar)), value).toBe(valid)
	expect(timestampToEpochNanos(value) !== null, value).toBe(valid)
	expect(eventJson(event(value)), value).toBe(valid)
	expect(Result.isSuccess(Schema.decodeUnknownResult(MapleCloudEventSchema)(event(value))), value).toBe(
		valid,
	)
	expect(Result.isSuccess(validateMapleCloudEvent(event(value))), value).toBe(valid)
	expect(projectionJson(projection(leaf, value)), value).toBe(valid)
	expect(
		Result.isSuccess(Schema.decodeUnknownResult(SignalProjectionSpecSchema)(projection(leaf, value))),
		value,
	).toBe(valid)
}

describe("published scalar schema conformance", () => {
	it("enforces exact signed int64 bounds for source scalars and selector literals", () => {
		const minimum = -9223372036854775808n
		const maximum = 9223372036854775807n
		const values = new Set(["0", "-0", "1", "-1", "9007199254740993", "99999999999999999999"])
		// Exercise each decimal prefix near both boundaries, with values on either side.
		for (let place = 1n; place <= 10n ** 20n; place *= 10n) {
			for (const bound of [minimum, maximum]) {
				for (const delta of [-1n, 0n, 1n]) values.add(((bound / place) * place + delta).toString())
			}
		}
		for (const value of values) {
			const valid = BigInt(value) >= minimum && BigInt(value) <= maximum
			for (const type of ["int64", "duration"] as const) {
				const scalar = { type, value }
				const selector: SignalPredicate = {
					op: "eq",
					field: { namespace: "attribute", key: "value", type },
					value: scalar,
				}
				expect(scalarJson(scalar), `${type}: ${value}`).toBe(valid)
				expect(Result.isSuccess(Schema.decodeUnknownResult(SignalScalarSchema)(scalar)), value).toBe(
					valid,
				)
				expect(Result.isSuccess(Schema.decodeUnknownResult(SignalLiteralSchema)(scalar)), value).toBe(
					valid,
				)
				expect(validateSignalScalar(scalar).length === 0, value).toBe(valid)
				expect(projectionJson(projection(selector)), value).toBe(valid)
			}
		}
		for (const value of ["", "+1", "01", "-01", "1.0", "1e3", " 1", "1\n"]) {
			expect(scalarJson({ type: "int64", value }), value).toBe(false)
			expect(
				Result.isSuccess(Schema.decodeUnknownResult(SignalScalarSchema)({ type: "int64", value })),
				value,
			).toBe(false)
		}
	})

	it("validates leap days across a complete Gregorian 400-year cycle", () => {
		for (let year = 1800; year < 2200; year++) {
			const valid = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
			checkTimestamp(`${year}-02-29T12:34:56.123456789Z`, valid)
		}
		checkTimestamp("0000-02-29T00:00:00Z", true)
		checkTimestamp("0001-02-29T00:00:00Z", false)
		checkTimestamp("9999-12-31T23:59:59Z", true)
	})

	it("rejects impossible dates, clocks, offsets and spellings at every timestamp boundary", () => {
		const monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
		for (let month = 1; month <= 12; month++) {
			for (const day of [0, 1, 28, 29, 30, 31, 32]) {
				checkTimestamp(
					`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00Z`,
					day >= 1 && day <= monthLengths[month - 1]!,
				)
			}
		}
		for (const value of [
			"2026-00-01T00:00:00Z",
			"2026-13-01T00:00:00Z",
			"2026-02-31T00:00:00Z",
			"2026-01-01T24:00:00Z",
			"2026-01-01T00:60:00Z",
			"2026-01-01T00:00:60Z",
			"2026-01-01T00:00:00+24:00",
			"2026-01-01T00:00:00-00:60",
			"2026-01-01T00:00:00",
			"2026-01-01t00:00:00z",
			"2026-01-01T00:00:00.Z",
			"2026-01-01T00:00:00.1234567890Z",
			"2026-01-01T00:00:00Z\n",
		])
			checkTimestamp(value, false)
		for (const value of [
			"2026-01-01T00:00:00.1Z",
			"2026-01-01T00:00:00+23:59",
			"2026-01-01T00:00:00-23:59",
			"2026-01-01T00:00:00-00:00",
		])
			checkTimestamp(value, true)
	})
})

describe("predicate topology conformance", () => {
	it("accepts reused subtrees just like their JSON representation", () => {
		const branch: SignalPredicate = { op: "not", clause: leaf }
		const shared: SignalPredicate = { op: "all", clauses: [branch, branch] }
		const decoded = Schema.decodeUnknownSync(SignalPredicateSchema)(shared)
		expect(decoded).toEqual(
			Schema.decodeUnknownSync(SignalPredicateSchema)(JSON.parse(JSON.stringify(shared))),
		)
		expect(projectionJson(projection(shared))).toBe(true)
		expect(() => Schema.decodeUnknownSync(SignalProjectionSpecSchema)(projection(shared))).not.toThrow()
	})

	it("counts every occurrence toward the 64-node limit", () => {
		const atLimit: SignalPredicate = { op: "all", clauses: Array.from({ length: 63 }, () => leaf) }
		const overLimit: SignalPredicate = { op: "all", clauses: Array.from({ length: 64 }, () => leaf) }
		expect(predicateInputBudgetIssue(atLimit)).toBeUndefined()
		expect(() => Schema.decodeUnknownSync(SignalPredicateSchema)(atLimit)).not.toThrow()
		expect(predicateInputBudgetIssue(overLimit)).toBe("predicate exceeds 64 nodes")
		expect(() => Schema.decodeUnknownSync(SignalPredicateSchema)(overLimit)).toThrow(/64 nodes/)
		// Whole-tree budgets require the mandatory preflight described in the artifact.
		expect(projectionJson(projection(overLimit))).toBe(true)
	})

	it("enforces root depth 1 through depth 8, and terminates actual cycles", () => {
		let selector: SignalPredicate = leaf
		for (let depth = 2; depth <= 8; depth++) selector = { op: "not", clause: selector }
		expect(() => Schema.decodeUnknownSync(SignalPredicateSchema)(selector)).not.toThrow()
		selector = { op: "not", clause: selector }
		expect(() => Schema.decodeUnknownSync(SignalPredicateSchema)(selector)).toThrow(/depth exceeds 8/)
		expect(projectionJson(projection(selector))).toBe(true)
		const cycle = { op: "not" }
		Object.assign(cycle, { clause: cycle })
		expect(predicateInputBudgetIssue(cycle)).toBe("predicate depth exceeds 8")
		expect(() => Schema.decodeUnknownSync(SignalPredicateSchema)(cycle)).toThrow(/depth exceeds 8/)
		expect(() =>
			Schema.decodeUnknownSync(SignalProjectionSpecSchema)({ ...projection(), selector: cycle }),
		).toThrow(/depth exceeds 8/)
	})

	it("publishes the mandatory whole-tree limits on the recursive predicate definition", () => {
		expect(projectionArtifact).toMatchObject({
			$defs: {
				SignalPredicate: {
					description: expect.stringMatching(
						/MUST enforce.*depth of 8.*root depth 1.*64 total predicate nodes/,
					),
				},
			},
		})
		expect(projectionArtifact).toMatchObject({
			$defs: {
				SignalPredicate: {
					description: expect.stringContaining("not expressed by JSON Schema validation keywords"),
				},
			},
		})
	})
})
