import { Effect, Result } from "effect"
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "vitest"
import {
	fieldKey,
	isJsonValue,
	ProjectorRegistry,
	type JsonValue,
	type NormalizedSignal,
	type SignalProjectionSpec,
	type SignalScalar,
} from "@maple/eventing-core"
import { normalizeOtlpLogs, normalizeOtlpLogsWithDiagnostics } from "../src/server/eventing/otlp"
import { sourceOccurrenceFingerprint } from "../src/server/eventing/runtime"
import { encodeLogs } from "../src/server/otlp/encode"
import { makeRuntime, metricRecorder, openStore, run } from "./eventing-test-support"

const withDataDir = async (run: (dataDir: string) => Promise<void>): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-eventing-runtime-"))
	const dataDir = join(parent, "data")
	mkdirSync(dataDir, { recursive: true })
	try {
		await run(dataDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const attr = (key: string, value: Record<string, unknown>) => ({ key, value })

const exampleRecordObserved = {
	resourceLogs: [
		{
			resource: {
				attributes: [
					attr("service.name", { stringValue: "example-service" }),
					attr("service.version", { stringValue: "19.1.0" }),
				],
			},
			scopeLogs: [
				{
					scope: { name: "example.event_store", version: "1.0.0" },
					logRecords: [
						{
							timeUnixNano: "1786131720123456789",
							observedTimeUnixNano: "1786131721123456789",
							eventName: "example.record.observed",
							severityNumber: 9,
							severityText: "INFO",
							body: { stringValue: "Record 42 observed" },
							attributes: [
								attr("event.id", { stringValue: "01K20EXAMPLERECORD42" }),
								attr("event.source", { stringValue: "https://events.example.test" }),
								attr("example.collection.id", { intValue: "7" }),
								attr("example.collection.name", { stringValue: "example/widgets" }),
								attr("example.record.id", { intValue: "4200" }),
								attr("example.record.sequence", { intValue: "42" }),
								attr("example.record.title", { stringValue: "Observe example events" }),
								attr("example.record.url", {
									stringValue: "https://events.example.test/collections/widgets/records/42",
								}),
								attr("example.actor.id", { intValue: "9" }),
								attr("example.actor.name", { stringValue: "observer" }),
							],
						},
					],
				},
			],
		},
	],
}

const firstLogRecord = (request: typeof exampleRecordObserved) =>
	request.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!

const projection = (overrides: Partial<SignalProjectionSpec> = {}): SignalProjectionSpec => ({
	id: "example-record-observed",
	revision: 1,
	enabled: true,
	tenantId: "local",
	sourceKind: "otel.log",
	selector: {
		op: "all",
		clauses: [
			{
				op: "eq",
				field: { namespace: "signal", key: "event.name", type: "string" },
				value: { type: "string", value: "example.record.observed" },
			},
			{
				op: "gte",
				field: { namespace: "attribute", key: "example.record.sequence", type: "int64" },
				value: { type: "int64", value: "1" },
			},
		],
	},
	projector: { id: "example.record.observed", version: 1, config: {} },
	activeFrom: "2000-01-01T00:00:00Z",
	...overrides,
})

const eventNameProjection = (id: string, eventName: string): SignalProjectionSpec =>
	projection({
		id,
		selector: {
			op: "eq",
			field: { namespace: "signal", key: "event.name", type: "string" },
			value: { type: "string", value: eventName },
		},
	})

const signalField = (
	signal: NormalizedSignal,
	namespace: "resource" | "attribute",
	key: string,
): SignalScalar | undefined => signal.fields.get(fieldKey({ namespace, key }))

const stringField = (
	signal: NormalizedSignal,
	namespace: "resource" | "attribute",
	key: string,
	required = false,
): string | undefined => {
	const value = signalField(signal, namespace, key)
	if (value === undefined) {
		if (required) throw new Error(`example event is missing ${key}`)
		return undefined
	}
	if (value.type !== "string") throw new Error(`example event ${key} must be a string`)
	return value.value
}

const int64Field = (signal: NormalizedSignal, key: string, required = false): string | undefined => {
	const value = signalField(signal, "attribute", key)
	if (value === undefined) {
		if (required) throw new Error(`example event is missing ${key}`)
		return undefined
	}
	if (value.type !== "int64") throw new Error(`example event ${key} must be an int64`)
	return value.value
}

const exampleProjectors = (): ProjectorRegistry =>
	Result.getOrThrow(
		new ProjectorRegistry().register({
			id: "example.record.observed",
			version: 1,
			sourceKinds: ["otel.log"],
			outputType: "dev.maple.example.record.observed.v1",
			dataSchema: "urn:maple:event-schema:example-record-observed:v1",
			decodeOutput: (value): JsonValue => {
				if (!isJsonValue(value)) throw new Error("example projector output must be finite JSON")
				return value
			},
			decodeConfig: (value) => {
				if (typeof value !== "object" || value === null || Array.isArray(value))
					throw new Error("example projector config must be an object")
				return {}
			},
			project: (signal) => {
				const collectionName = stringField(signal, "attribute", "example.collection.name", true)!
				const sequence = int64Field(signal, "example.record.sequence", true)!
				return {
					subject: `${collectionName}/records/${sequence}`,
					data: {
						collection: {
							id: int64Field(signal, "example.collection.id"),
							name: collectionName,
						},
						record: {
							id: int64Field(signal, "example.record.id"),
							sequence,
							title: stringField(signal, "attribute", "example.record.title"),
							url: stringField(signal, "attribute", "example.record.url"),
						},
						actor: {
							id: int64Field(signal, "example.actor.id"),
							name: stringField(signal, "attribute", "example.actor.name"),
						},
						serviceName: stringField(signal, "resource", "service.name"),
					},
				}
			},
		}),
	)

describe("OTLP eventing input validation", () => {
	it("rejects non-string attribute keys before normalization", () => {
		throws(
			() =>
				run(
					normalizeOtlpLogs({
						resourceLogs: [
							{
								scopeLogs: [
									{
										logRecords: [
											{
												timeUnixNano: "1786125600000000000",
												attributes: [{ key: 123, value: { stringValue: "bad" } }],
											},
										],
									},
								],
							},
						],
					}),
				),
			/invalid OTLP logs/,
		)
	})
})

describe("LocalEventingRuntime", () => {
	it("records bounded normalization and projection outcomes without signal data", async () =>
		withDataDir(async (dataDir) => {
			const metrics = metricRecorder()
			const observed = <A, E>(effect: Effect.Effect<A, E>): A => run(metrics.observe(effect))
			const store = await openStore(dataDir)
			try {
				const runtime = makeRuntime(store, exampleProjectors())
				run(runtime.activate(projection()))
				strictEqual(observed(runtime.evaluateOtlp("logs", exampleRecordObserved)).events.length, 1)

				const malformed = structuredClone(exampleRecordObserved)
				firstLogRecord(malformed).attributes = firstLogRecord(malformed).attributes.filter(
					({ key }) => key !== "example.collection.name",
				)
				strictEqual(observed(runtime.evaluateOtlp("logs", malformed)).failures.length, 1)

				const mismatched = structuredClone(exampleRecordObserved)
				firstLogRecord(mismatched).attributes = firstLogRecord(mismatched).attributes.map((entry) =>
					entry.key === "example.record.sequence" ? attr(entry.key, { stringValue: "42" }) : entry,
				)
				deepStrictEqual(observed(runtime.evaluateOtlp("logs", mismatched)).typeMismatchFields, [
					"attribute:example.record.sequence",
				])

				const projectionBoundFailure = structuredClone(exampleRecordObserved)
				firstLogRecord(projectionBoundFailure).attributes.push(
					...Array.from({ length: 257 }, (_, index) =>
						attr(`projection-only-${index}`, { stringValue: "warehouse-valid" }),
					),
				)
				strictEqual(observed(runtime.evaluateOtlp("logs", projectionBoundFailure)).events.length, 0)

				const operationOutcomes = metrics.operationOutcomes()
				ok(operationOutcomes.includes("normalization:success"))
				ok(operationOutcomes.includes("normalization:failure"))
				ok(operationOutcomes.includes("projection:success"))
				ok(operationOutcomes.includes("projection:failure"))
				ok(operationOutcomes.includes("selector_type_mismatch:observed"))
				const serialized = metrics.attributes()
				strictEqual(serialized.includes("Observe example events"), false)
				strictEqual(serialized.includes("01K20EXAMPLERECORD42"), false)
				strictEqual(serialized.includes("example-record-observed"), false)
				strictEqual(serialized.includes("example.record.sequence"), false)
			} finally {
				await store.close()
			}
		}))

	it("normalizes typed generic OTLP fields while preserving the existing warehouse encoding", () => {
		const [signal] = run(normalizeOtlpLogs(exampleRecordObserved, "2026-08-07T20:00:00Z"))
		strictEqual(signal?.occurrenceId, "01K20EXAMPLERECORD42")
		strictEqual(signal?.identityQuality, "source")
		strictEqual(signal?.source, "https://events.example.test")
		deepStrictEqual(signal?.fields.get("attribute:example.record.sequence"), {
			type: "int64",
			value: "42",
		})
		const batches = encodeLogs(exampleRecordObserved)
		strictEqual(batches.length, 1)
		strictEqual(batches[0]?.rowCount, 1)
		strictEqual(JSON.parse(batches[0]!.ndjson).log_attributes["example.record.sequence"], "42")
	})

	it("uses the first nonblank occurrence alias and derives identity when every alias is blank", () => {
		const aliased = structuredClone(exampleRecordObserved)
		const aliasedRecord = firstLogRecord(aliased)
		aliasedRecord.attributes = [
			attr("event.id", { stringValue: "   " }),
			attr("cloudevents.id", { stringValue: " cloud-event-42 " }),
			...aliasedRecord.attributes.filter(({ key }) => !["event.id", "cloudevents.id"].includes(key)),
		]
		const [aliasedSignal] = run(normalizeOtlpLogs(aliased, "2026-08-07T20:00:00Z"))
		strictEqual(aliasedSignal?.occurrenceId, "cloud-event-42")
		strictEqual(aliasedSignal?.identityQuality, "source")

		const derivedA = structuredClone(aliased)
		const derivedARecord = firstLogRecord(derivedA)
		derivedARecord.attributes = derivedARecord.attributes.map((entry) =>
			["event.id", "cloudevents.id"].includes(entry.key)
				? attr(entry.key, { stringValue: entry.key === "event.id" ? "" : " \t " })
				: entry,
		)
		const derivedB = structuredClone(derivedA)
		firstLogRecord(derivedB).body = { stringValue: "A different record occurrence" }
		const [signalA] = run(normalizeOtlpLogs(derivedA, "2026-08-07T20:00:00Z"))
		const [signalB] = run(normalizeOtlpLogs(derivedB, "2026-08-07T20:00:00Z"))
		strictEqual(signalA?.identityQuality, "derived")
		strictEqual(signalB?.identityQuality, "derived")
		strictEqual(signalA?.occurrenceId?.startsWith("derived:sha256:"), true)
		strictEqual(signalA?.occurrenceId === signalB?.occurrenceId, false)
	})

	it("keeps projectable retries byte-identical and skips timestamp-less durable logs", () => {
		const first = run(normalizeOtlpLogs(exampleRecordObserved, "2026-08-07T20:00:00Z"))
		const retry = run(normalizeOtlpLogs(exampleRecordObserved, "2026-08-08T20:00:00Z"))
		deepStrictEqual(first, retry)

		const timestampLess = structuredClone(exampleRecordObserved)
		const timestampLessRecord = firstLogRecord(timestampLess) as {
			timeUnixNano?: string
			observedTimeUnixNano?: string
		}
		delete timestampLessRecord.timeUnixNano
		delete timestampLessRecord.observedTimeUnixNano
		deepStrictEqual(run(normalizeOtlpLogs(timestampLess, "2026-08-07T20:00:00Z")), [])
		deepStrictEqual(
			run(normalizeOtlpLogsWithDiagnostics(timestampLess, "2026-08-07T20:00:00Z"))
				.unprojectedIdentities,
			[
				{
					sourceKind: "otel.log",
					source: "https://events.example.test",
					tenantId: "local",
					occurrenceId: "01K20EXAMPLERECORD42",
					occurredAt: null,
				},
			],
		)
	})

	it("uses a locale-independent source-fingerprint field order", () => {
		const [signal] = run(normalizeOtlpLogs(exampleRecordObserved, "2026-08-07T20:00:00Z"))
		const fields = new Map(signal!.fields)
		fields.set("attribute:ä", { type: "string", value: "umlaut" })
		fields.set("attribute:z", { type: "string", value: "ascii" })
		const forward = { ...signal!, fields }
		const reverse = { ...signal!, fields: new Map([...fields].reverse()) }
		strictEqual(
			Result.getOrThrow(sourceOccurrenceFingerprint(forward)),
			Result.getOrThrow(sourceOccurrenceFingerprint(reverse)),
		)
		strictEqual(
			Result.getOrThrow(sourceOccurrenceFingerprint(forward)),
			"sha256:4ed4d210645f2df1959e5c56acb5b22140a01aa267fdf1fab8b62e56ea63e31e",
		)
	})

	it("preserves __proto__ as ordinary OTLP data without prototype mutation", () => {
		const request = structuredClone(exampleRecordObserved)
		firstLogRecord(request).attributes.push(
			attr("__proto__", {
				kvlistValue: { values: [attr("nested", { stringValue: "top-level" })] },
			}),
			attr("safe", {
				kvlistValue: { values: [attr("__proto__", { stringValue: "nested" })] },
			}),
		)
		const [signal] = run(normalizeOtlpLogs(request, "2026-08-07T20:00:00Z"))
		const record = (signal!.data as { record: { attributes: Record<string, JsonValue> } }).record
		ok(Object.prototype.hasOwnProperty.call(record.attributes, "__proto__"))
		// Attribute maps are null-prototype on purpose, so a `__proto__` key stays data.
		deepStrictEqual(
			record.attributes["__proto__"],
			Object.assign(Object.create(null), { nested: "top-level" }),
		)
		const safe = record.attributes.safe as Record<string, JsonValue>
		ok(Object.prototype.hasOwnProperty.call(safe, "__proto__"))
		strictEqual(safe["__proto__"], "nested")
		strictEqual(Object.prototype.hasOwnProperty.call({}, "nested"), false)
	})

	it("catalogs only the scalar body field that the OTLP adapter can populate", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				const runtime = makeRuntime(store, exampleProjectors())
				throws(
					() =>
						run(
							runtime.prepareActivation(
								projection({
									selector: {
										op: "exists",
										field: { namespace: "body", key: "text", type: "string" },
									},
								}),
							),
						),
					/unknown field body:text/,
				)
				const activation = run(
					runtime.prepareActivation(
						projection({
							selector: {
								op: "exists",
								field: { namespace: "body", key: "value", type: "boolean" },
							},
						}),
					),
				)
				strictEqual(activation.spec.selector.op, "exists")
			} finally {
				await store.close()
			}
		}))

	it("projects before storage, deduplicates retry delivery, and makes the event ready after commit", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				const runtime = makeRuntime(store, exampleProjectors())
				strictEqual(run(runtime.hasActiveSource("otel.log")), false)
				run(runtime.activate(projection()))
				const first = run(runtime.evaluateOtlp("logs", exampleRecordObserved))
				strictEqual(first.failures.length, 0)
				strictEqual(first.events.length, 1)
				deepStrictEqual(first.events[0], {
					specversion: "1.0",
					id: first.events[0]!.id,
					source: "https://events.example.test",
					type: "dev.maple.example.record.observed.v1",
					subject: "example/widgets/records/42",
					time: "2026-08-07T19:42:00.123456789Z",
					datacontenttype: "application/json",
					dataschema: "urn:maple:event-schema:example-record-observed:v1",
					tenantid: "local",
					projectionid: "example-record-observed",
					projectionrevision: 1,
					projectorid: "example.record.observed",
					projectorversion: 1,
					sourceoccurrenceid: "01K20EXAMPLERECORD42",
					identityquality: "source",
					data: {
						collection: { id: "7", name: "example/widgets" },
						record: {
							id: "4200",
							sequence: "42",
							title: "Observe example events",
							url: "https://events.example.test/collections/widgets/records/42",
						},
						actor: { id: "9", name: "observer" },
						serviceName: "example-service",
					},
				})
				const staged = run(runtime.stage(first.events, first.eventSourceFingerprints))
				strictEqual(staged.inserted, 1)
				strictEqual(run(runtime.listReady()).events.length, 0)
				deepStrictEqual(
					run(runtime.listStaged()).events.map(({ event }) => event),
					first.events,
				)
				run(runtime.activate(projection({ revision: 2, enabled: false })))
				const projectionIneligibleRetry = structuredClone(exampleRecordObserved)
				firstLogRecord(projectionIneligibleRetry).attributes.push(
					...Array.from({ length: 257 }, (_, index) =>
						attr(`retry-projection-only-${index}`, { stringValue: "warehouse-valid" }),
					),
				)
				throws(
					() => run(runtime.evaluateOtlp("logs", projectionIneligibleRetry, () => true)),
					/cannot safely recover staged source occurrence/,
				)
				strictEqual(run(runtime.listStaged()).events.length, 1)
				strictEqual(run(runtime.listReady()).events.length, 0)
				const changedRetry = structuredClone(exampleRecordObserved)
				firstLogRecord(changedRetry).body = { stringValue: "changed retry content" }
				throws(
					() => run(runtime.evaluateOtlp("logs", changedRetry, () => true)),
					/staged source occurrence collision/,
				)
				strictEqual(run(runtime.listStaged()).events.length, 1)
				strictEqual(run(runtime.listReady()).events.length, 0)
				const retry = run(runtime.evaluateOtlp("logs", exampleRecordObserved, () => true))
				deepStrictEqual(retry.events, [])
				deepStrictEqual(retry.recoveredEventIds, staged.eventIds)
				run(runtime.markReady(retry.recoveredEventIds))
				deepStrictEqual(
					run(runtime.listReady()).events.map(({ event }) => event),
					first.events,
				)
				deepStrictEqual(run(runtime.listStaged()).events, [])
			} finally {
				await store.close()
			}
		}))

	it("rejects same event bytes with conflicting source content within one batch", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				const runtime = makeRuntime(store, exampleProjectors())
				run(runtime.activate(projection()))
				const request = structuredClone(exampleRecordObserved)
				const first = firstLogRecord(request)
				first.attributes.push(attr("example.projector.ignored", { stringValue: "first" }))
				const second = structuredClone(first)
				second.attributes = second.attributes.map((entry) =>
					entry.key === "example.projector.ignored"
						? attr(entry.key, { stringValue: "second" })
						: entry,
				)
				request.resourceLogs[0]!.scopeLogs[0]!.logRecords.push(second)
				throws(
					() => run(runtime.evaluateOtlp("logs", request)),
					/source occurrence collision within one ingest batch/,
				)
				strictEqual(run(runtime.listStaged()).events.length, 0)
				strictEqual(run(runtime.listReady()).events.length, 0)
			} finally {
				await store.close()
			}
		}))

	it("rejects matching and nonmatching records that reuse one source occurrence", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				const runtime = makeRuntime(store, exampleProjectors())
				run(runtime.activate(eventNameProjection("observed-only", "example.record.observed")))
				const request = structuredClone(exampleRecordObserved)
				const sibling = structuredClone(firstLogRecord(request))
				sibling.eventName = "example.record.ignored"
				request.resourceLogs[0]!.scopeLogs[0]!.logRecords.push(sibling)
				throws(
					() => run(runtime.evaluateOtlp("logs", request)),
					/source occurrence collision within one ingest batch/,
				)
				strictEqual(run(runtime.listStaged()).events.length, 0)
				strictEqual(run(runtime.listReady()).events.length, 0)
			} finally {
				await store.close()
			}
		}))

	it("rejects projectable and projection-ineligible records with one source occurrence", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				const runtime = makeRuntime(store, exampleProjectors())
				run(runtime.activate(projection()))
				const request = structuredClone(exampleRecordObserved)
				const sibling = structuredClone(firstLogRecord(request))
				sibling.attributes.push(
					...Array.from({ length: 257 }, (_, index) =>
						attr(`projection-only-sibling-${index}`, { stringValue: "warehouse-valid" }),
					),
				)
				request.resourceLogs[0]!.scopeLogs[0]!.logRecords.push(sibling)
				throws(
					() => run(runtime.evaluateOtlp("logs", request)),
					/source occurrence collision with an unprojectable record within one ingest batch/,
				)
				strictEqual(run(runtime.listStaged()).events.length, 0)
				strictEqual(run(runtime.listReady()).events.length, 0)
			} finally {
				await store.close()
			}
		}))

	it("rejects disjoint projections over conflicting records with one source occurrence", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				const runtime = makeRuntime(store, exampleProjectors())
				run(runtime.activate(eventNameProjection("observed-events", "example.record.observed")))
				run(runtime.activate(eventNameProjection("alternate-events", "example.record.alternate")))
				const request = structuredClone(exampleRecordObserved)
				const sibling = structuredClone(firstLogRecord(request))
				sibling.eventName = "example.record.alternate"
				request.resourceLogs[0]!.scopeLogs[0]!.logRecords.push(sibling)
				throws(
					() => run(runtime.evaluateOtlp("logs", request)),
					/source occurrence collision within one ingest batch/,
				)
				strictEqual(run(runtime.listStaged()).events.length, 0)
				strictEqual(run(runtime.listReady()).events.length, 0)
			} finally {
				await store.close()
			}
		}))

	it("activates a validated revision without restart and reloads it after restart", async () =>
		withDataDir(async (dataDir) => {
			let store = await openStore(dataDir)
			let runtime = makeRuntime(store, exampleProjectors())
			run(runtime.activate(projection()))
			strictEqual(run(runtime.evaluateOtlp("logs", exampleRecordObserved)).events.length, 1)
			run(
				runtime.activate(
					projection({
						revision: 2,
						selector: {
							op: "eq",
							field: { namespace: "signal", key: "event.name", type: "string" },
							value: { type: "string", value: "example.record.closed" },
						},
					}),
				),
			)
			strictEqual(run(runtime.evaluateOtlp("logs", exampleRecordObserved)).events.length, 0)
			await store.close()

			store = await openStore(dataDir)
			try {
				runtime = makeRuntime(store, exampleProjectors())
				strictEqual(run(runtime.listActive)[0]?.revision, 2)
				strictEqual(run(runtime.evaluateOtlp("logs", exampleRecordObserved)).events.length, 0)
			} finally {
				await store.close()
			}
		}))

	it("does no normalization or event work for a source with no active projection", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				const runtime = makeRuntime(store)
				deepStrictEqual(run(runtime.evaluateOtlp("logs", { malformed: Symbol("not decoded") })), {
					events: [],
					eventSourceFingerprints: new Map(),
					recoveredEventIds: [],
					failures: [],
					typeMismatchFields: [],
				})
			} finally {
				await store.close()
			}
		}))
})
