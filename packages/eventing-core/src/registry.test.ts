import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	CompiledProjectionRegistry,
	canonicalJson,
	defineSignalFields,
	isJsonValue,
	makeEventId,
	MAX_CLOUD_EVENT_BYTES,
	ProjectorRegistry,
	SignalSourceRegistry,
	validateMapleCloudEvent,
	makeCloudEvent,
	SignalProjectionSpecSchema,
	type NormalizedSignal,
	type JsonValue,
	type SignalProjectionSpec,
} from "./index"

interface CyclicJsonFixture {
	self?: CyclicJsonFixture
}

const decodeJsonOutput = (value: unknown): JsonValue => {
	if (!isJsonValue(value)) throw new Error("projector output must be finite JSON")
	return value
}

const signal = (overrides: Partial<NormalizedSignal> = {}): NormalizedSignal => ({
	sourceKind: "otel.log",
	source: "urn:maple:source:otel:local",
	tenantId: "tenant-a",
	occurrenceId: "event-123",
	identityQuality: "source",
	occurredAt: "2026-08-07T19:42:00.123456789Z",
	observedAt: "2026-08-07T19:42:01Z",
	subject: "records/42",
	fields: defineSignalFields([
		{
			field: { namespace: "attribute", key: "event.name", type: "string" },
			value: { type: "string", value: "example.record.observed" },
		},
	]),
	data: { record: { id: 42, label: "Example" } },
	...overrides,
})

const projection = (overrides: Partial<SignalProjectionSpec> = {}): SignalProjectionSpec => ({
	id: "example-record-observed",
	revision: 3,
	enabled: true,
	tenantId: "tenant-a",
	sourceKind: "otel.log",
	selector: {
		op: "eq",
		field: { namespace: "attribute", key: "event.name", type: "string" },
		value: { type: "string", value: "example.record.observed" },
	},
	projector: { id: "example.record", version: 1, config: { includeLabel: true } },
	activeFrom: "2026-08-07T00:00:00Z",
	...overrides,
})

const projectors = (): ProjectorRegistry =>
	Result.getOrThrow(
		new ProjectorRegistry().register({
			id: "example.record",
			version: 1,
			sourceKinds: ["otel.log"],
			outputType: "dev.maple.example.record.observed.v1",
			dataSchema: "urn:maple:event-schema:example-record:v1",
			decodeOutput: decodeJsonOutput,
			decodeConfig: (value) => {
				if (typeof value !== "object" || value === null) throw new Error("invalid projector config")
				return value
			},
			project: (input) => ({ data: input.data as { record: { id: number; label: string } } }),
		}),
	)

const sources = (): SignalSourceRegistry =>
	Result.getOrThrow(
		new SignalSourceRegistry().register({
			sourceKind: "otel.log",
			fields: [
				{
					field: { namespace: "attribute", key: "event.name", type: "string" },
					operators: ["exists", "eq", "neq", "contains", "in"],
					sensitivity: "public",
					replay: "coerced",
				},
			],
			openFields: [
				{
					namespace: "attribute",
					types: ["string", "boolean", "int64", "float64", "timestamp", "duration"],
					operators: ["exists", "eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"],
					sensitivity: "public",
					replay: "coerced",
				},
			],
		}),
	)

describe("CompiledProjectionRegistry", () => {
	const acceptedAt = "2026-08-07T20:00:00Z"
	it("canonicalizes JSON independently of object insertion order", () => {
		expect(canonicalJson({ z: 1, nested: { b: true, a: [2, 1] }, a: "first" })).toBe(
			'{"a":"first","nested":{"a":[2,1],"b":true},"z":1}',
		)
		const shared = { value: 1 }
		expect(canonicalJson({ left: shared, right: shared })).toBe(
			'{"left":{"value":1},"right":{"value":1}}',
		)
		const cyclic: CyclicJsonFixture = {}
		cyclic.self = cyclic
		// SAFETY: this fixture deliberately violates JsonValue to exercise cycle rejection.
		expect(() => canonicalJson(cyclic as JsonValue)).toThrow("finite acyclic JSON")
		expect(() => canonicalJson({ invalid: Number.NaN })).toThrow("finite acyclic JSON")
	})

	it("projects every match into a deterministic CloudEvent", () => {
		const registry = Result.getOrThrow(
			CompiledProjectionRegistry.compile([projection()], sources(), projectors()),
		)
		const first = Result.getOrThrow(registry.evaluate(signal(), acceptedAt))
		const second = Result.getOrThrow(registry.evaluate(signal(), acceptedAt))
		expect(first.failures).toEqual([])
		expect(first.events).toEqual(second.events)
		expect(first.events).toHaveLength(1)
		expect(first.events[0]).toMatchObject({
			specversion: "1.0",
			id: makeEventId({
				tenantId: "tenant-a",
				sourceKind: "otel.log",
				source: "urn:maple:source:otel:local",
				occurrenceId: "event-123",
				projectionId: "example-record-observed",
				projectionRevision: 3,
			}),
			type: "dev.maple.example.record.observed.v1",
			subject: "records/42",
			projectionrevision: 3,
			sourceoccurrenceid: "event-123",
			identityquality: "source",
			data: signal().data,
		})
	})

	it("lets a projector clear an inherited subject explicitly", () => {
		const input = {
			signal: signal(),
			projection: projection(),
			projectorId: "example.record",
			projectorVersion: 1,
			outputType: "dev.maple.example.record.observed.v1",
			dataSchema: "urn:maple:event-schema:example-record:v1",
			data: {},
		}
		expect(Result.getOrThrow(makeCloudEvent(input)).subject).toBe("records/42")
		expect(Result.getOrThrow(makeCloudEvent({ ...input, subject: null })).subject).toBeUndefined()
	})

	it("validates historical CloudEvents that predate source identity extensions", () => {
		const registry = Result.getOrThrow(
			CompiledProjectionRegistry.compile([projection()], sources(), projectors()),
		)
		const event = Result.getOrThrow(registry.evaluate(signal(), acceptedAt)).events[0]!
		const { sourceoccurrenceid: _occurrence, identityquality: _quality, ...historical } = event
		const validated = Result.getOrThrow(validateMapleCloudEvent(historical)).event
		expect(validated.id).toBe(event.id)
		expect(validated.sourceoccurrenceid).toBeUndefined()
		expect(validated.identityquality).toBeUndefined()
	})

	it("runs every matching projection from one immutable registry snapshot", () => {
		const registry = Result.getOrThrow(
			CompiledProjectionRegistry.compile(
				[projection(), projection({ id: "example-record-observed-audit" })],
				sources(),
				projectors(),
			),
		)
		const result = Result.getOrThrow(registry.evaluate(signal(), acceptedAt))
		expect(result.failures).toEqual([])
		expect(result.events.map(({ projectionid }) => projectionid)).toEqual([
			"example-record-observed",
			"example-record-observed-audit",
		])
	})

	it("runs all matching projections and isolates projector failures", () => {
		const registryDefinitions = Result.getOrThrow(
			projectors().register({
				id: "broken",
				version: 1,
				sourceKinds: ["otel.log"],
				outputType: "dev.maple.broken.v1",
				dataSchema: "urn:maple:event-schema:broken:v1",
				decodeOutput: decodeJsonOutput,
				decodeConfig: () => ({}),
				project: () => {
					throw new Error("projector invariant failed")
				},
			}),
		)
		Result.getOrThrow(
			registryDefinitions.register({
				id: "invalid-output",
				version: 1,
				sourceKinds: ["otel.log"],
				outputType: "dev.maple.invalid-output.v1",
				dataSchema: "urn:maple:event-schema:invalid-output:v1",
				decodeConfig: () => ({}),
				decodeOutput: () => {
					throw new Error("projector output violated declared schema")
				},
				project: () => ({ data: { invalid: true } }),
			}),
		)
		const registry = Result.getOrThrow(
			CompiledProjectionRegistry.compile(
				[
					projection(),
					projection({
						id: "broken-projection",
						projector: { id: "broken", version: 1, config: {} },
					}),
					projection({
						id: "invalid-output-projection",
						projector: { id: "invalid-output", version: 1, config: {} },
					}),
				],
				sources(),
				registryDefinitions,
			),
		)
		const result = Result.getOrThrow(registry.evaluate(signal(), acceptedAt))
		expect(result.events).toHaveLength(1)
		expect(result.failures).toEqual([
			expect.objectContaining({
				projectionId: "broken-projection",
				message: "projector invariant failed",
			}),
			expect.objectContaining({
				projectionId: "invalid-output-projection",
				message: "projector output violated declared schema",
			}),
		])
	})

	it("isolates complete-envelope schema and size failures from successful siblings", () => {
		const registryDefinitions = Result.getOrThrow(
			Result.getOrThrow(
				projectors().register({
					id: "oversized",
					version: 1,
					sourceKinds: ["otel.log"],
					outputType: "dev.maple.oversized.v1",
					dataSchema: "urn:maple:event-schema:oversized:v1",
					decodeOutput: decodeJsonOutput,
					decodeConfig: () => ({}),
					project: () => ({ data: { payload: "x".repeat(MAX_CLOUD_EVENT_BYTES) } }),
				}),
			).register({
				id: "invalid-envelope",
				version: 1,
				sourceKinds: ["otel.log"],
				outputType: "x".repeat(257),
				dataSchema: "urn:maple:event-schema:invalid-envelope:v1",
				decodeOutput: decodeJsonOutput,
				decodeConfig: () => ({}),
				project: () => ({ data: {} }),
			}),
		)
		const registry = Result.getOrThrow(
			CompiledProjectionRegistry.compile(
				[
					projection(),
					projection({
						id: "oversized-projection",
						projector: { id: "oversized", version: 1, config: {} },
					}),
					projection({
						id: "invalid-envelope-projection",
						projector: { id: "invalid-envelope", version: 1, config: {} },
					}),
				],
				sources(),
				registryDefinitions,
			),
		)
		const result = Result.getOrThrow(registry.evaluate(signal(), acceptedAt))
		expect(result.events.map(({ projectionid }) => projectionid)).toEqual(["example-record-observed"])
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					projectionId: "oversized-projection",
					message: expect.stringContaining("CloudEvent exceeds"),
				}),
				expect.objectContaining({
					projectionId: "invalid-envelope-projection",
				}),
			]),
		)
	})

	it("isolates tenants, source kinds, activation time, and disabled revisions", () => {
		const registry = Result.getOrThrow(
			CompiledProjectionRegistry.compile(
				[
					projection(),
					projection({ id: "future", revision: 1, activeFrom: "2026-08-08T00:00:00Z" }),
					projection({ id: "disabled", revision: 1, enabled: false }),
					projection({ id: "other-tenant", revision: 1, tenantId: "tenant-b" }),
				],
				sources(),
				projectors(),
			),
		)
		expect(
			Result.getOrThrow(
				registry.evaluate(signal({ observedAt: "1999-01-01T00:00:00Z" }), acceptedAt),
			).events.map(({ projectionid }) => projectionid),
		).toEqual(["example-record-observed"])
		expect(
			Result.getOrThrow(registry.evaluate(signal({ sourceKind: "otel.span" }), acceptedAt)).events,
		).toEqual([])
		expect(
			Result.getOrThrow(
				registry.evaluate(signal({ observedAt: "2099-01-01T00:00:00Z" }), "2026-08-07T00:00:00Z"),
			).events.map(({ projectionid }) => projectionid),
		).toEqual(["example-record-observed"])
	})

	it("requires occurrence identity for durable projection", () => {
		const registry = Result.getOrThrow(
			CompiledProjectionRegistry.compile([projection()], sources(), projectors()),
		)
		const result = Result.getOrThrow(
			registry.evaluate(signal({ occurrenceId: null, identityQuality: "none" }), acceptedAt),
		)
		expect(result.events).toEqual([])
		expect(result.failures[0]?.message).toBe(
			"durable event projection requires stable or derived occurrence identity",
		)
	})

	it("rejects duplicate registrations, projection revisions, and invalid projector bindings", () => {
		const definitions = projectors()
		expect(() =>
			Result.getOrThrow(
				definitions.register({
					id: "example.record",
					version: 1,
					sourceKinds: ["otel.log"],
					outputType: "duplicate",
					dataSchema: "duplicate",
					decodeOutput: decodeJsonOutput,
					decodeConfig: (value) => value,
					project: () => ({ data: {} }),
				}),
			),
		).toThrow("duplicate projector registration")
		expect(() =>
			Result.getOrThrow(
				CompiledProjectionRegistry.compile([projection(), projection()], sources(), projectors()),
			),
		).toThrow("duplicate projection revision")
		expect(() =>
			Result.getOrThrow(
				CompiledProjectionRegistry.compile(
					[projection({ projector: { id: "missing", version: 1, config: {} } })],
					sources(),
					projectors(),
				),
			),
		).toThrow("unregistered projector")
	})

	it("validates selector fields and operators against the source catalog", () => {
		const closed = Result.getOrThrow(
			new SignalSourceRegistry().register({
				sourceKind: "otel.log",
				fields: [
					{
						field: { namespace: "attribute", key: "event.name", type: "string" },
						operators: ["eq"],
						sensitivity: "public",
						replay: "coerced",
					},
				],
			}),
		)
		expect(() =>
			Result.getOrThrow(
				CompiledProjectionRegistry.compile(
					[
						projection({
							selector: {
								op: "contains",
								field: { namespace: "attribute", key: "event.name", type: "string" },
								value: { type: "string", value: "example" },
							},
						}),
					],
					closed,
					projectors(),
				),
			),
		).toThrow("contains is not allowed for catalog field")
		expect(() =>
			Result.getOrThrow(
				CompiledProjectionRegistry.compile(
					[
						projection({
							selector: {
								op: "eq",
								field: { namespace: "attribute", key: "unknown", type: "string" },
								value: { type: "string", value: "x" },
							},
						}),
					],
					closed,
					projectors(),
				),
			),
		).toThrow("unknown field attribute:unknown")
	})
})

describe("projection input budgets", () => {
	it("rejects excessive nesting before the recursive compile decoder", () => {
		const spec = projection()
		let selector = spec.selector
		for (let depth = 0; depth < 10000; depth++) selector = { op: "not", clause: selector }
		expect(() =>
			Result.getOrThrow(
				CompiledProjectionRegistry.compile([{ ...spec, selector }], sources(), projectors()),
			),
		).toThrow(/predicate depth/)
	})
})

describe("schema topology boundary", () => {
	it("rejects a hostile selector through the exported schema itself", () => {
		let selector: import("./model").SignalPredicate = {
			op: "exists",
			field: { namespace: "attribute", key: "x", type: "string" },
		}
		for (let i = 0; i < 10000; i++) selector = { op: "not", clause: selector }
		const decoded = Schema.decodeUnknownResult(SignalProjectionSpecSchema)({ ...projection(), selector })
		expect(Result.isFailure(decoded)).toBe(true)
		if (Result.isFailure(decoded)) expect(decoded.failure.message).toContain("depth")
	})
})
