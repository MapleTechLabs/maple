import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert"
import { Effect } from "effect"
import { describe, it } from "vitest"
import { EventingControlStoreError } from "../src/server/eventing/control-store"
import { normalizeOtlpLogs } from "../src/server/eventing/otlp"
import {
	type LocalEventingRuntimeApi,
	ProjectionActivationConflict,
	SourceOccurrenceCollision,
} from "../src/server/eventing/runtime"
import { __testables } from "../src/server/serve"
import { run, serveCheckpointWith, serveWith } from "./eventing-test-support"

describe("Local eventing ingest seam", () => {
	it("requires maintenance authorization and exposes staged records only when requested", async () => {
		const eventing = {
			health: Effect.succeed({ activeProjections: 1 }),
			listActive: Effect.succeed([]),
			listReady: () =>
				Effect.succeed({ events: [{ sequence: 1, event: { id: "ready" } }], nextCursor: null }),
			listStaged: (_limit: number, after: number) =>
				Effect.succeed({
					events: [{ sequence: after + 1, event: { id: "staged" } }],
					nextCursor: null,
				}),
		}
		const unauthorized = await serveWith(
			eventing as never,
			__testables.handleEventingRead(
				"maintenance-secret",
				new Request("http://127.0.0.1/local/eventing/outbox?state=staged"),
				new URL("http://127.0.0.1/local/eventing/outbox?state=staged"),
			),
		)
		strictEqual(unauthorized.status, 403)

		const request = new Request("http://127.0.0.1/local/eventing/outbox?state=staged&after=41", {
			headers: { "x-maple-maintenance-token": "maintenance-secret" },
		})
		const authorized = await serveWith(
			eventing as never,
			__testables.handleEventingRead("maintenance-secret", request, new URL(request.url)),
		)
		strictEqual(authorized.status, 200)
		deepStrictEqual(await authorized.json(), {
			events: [{ sequence: 42, event: { id: "staged" } }],
			nextCursor: null,
		})
	})

	it("authenticates and reads activation bodies before closing admission", async () => {
		const gate = new __testables.RequestQuiescenceGate()
		const neverClosed = new ReadableStream<Uint8Array>()
		const unauthorized = await serveWith(
			{} as never,
			__testables.handleProjectionActivation(gate, "maintenance-secret", {
				headers: new Headers(),
				body: neverClosed,
			} as Request),
		)
		strictEqual(unauthorized.status, 403)
		const afterUnauthorized = gate.enter()
		ok(afterUnauthorized, "invalid authorization must not close admission")
		afterUnauthorized()

		const checkpointUnauthorized = await serveCheckpointWith(
			{} as never,
			__testables.handleCheckpointBackup({} as never, "/unused", gate, "maintenance-secret", {
				headers: new Headers(),
				body: neverClosed,
			} as Request),
		)
		strictEqual(checkpointUnauthorized.status, 403)
		const afterCheckpointUnauthorized = gate.enter()
		ok(afterCheckpointUnauthorized, "checkpoint authorization must precede exclusivity")
		afterCheckpointUnauthorized()

		let controller!: ReadableStreamDefaultController<Uint8Array>
		const slowBody = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value
			},
		})
		let committed = false
		const pending = serveWith(
			{
				prepareActivation: (body: unknown) => Effect.succeed({ body }),
				commitActivation: () =>
					Effect.sync(() => {
						committed = true
					}),
				listActive: Effect.succeed([]),
			} as never,
			__testables.handleProjectionActivation(gate, "maintenance-secret", {
				headers: new Headers({ "x-maple-maintenance-token": "maintenance-secret" }),
				body: slowBody,
			} as Request),
		)
		await Promise.resolve()
		const whileReading = gate.enter()
		ok(whileReading, "an incomplete request body must not close admission")
		whileReading()
		controller.enqueue(new TextEncoder().encode("{}"))
		controller.close()
		strictEqual((await pending).status, 200)
		strictEqual(committed, true)
	})

	it("bounds activation bodies and reports concurrent maintenance intentionally", async () => {
		const oversized = new Request("http://127.0.0.1/local/eventing/projections", {
			method: "POST",
			body: "123456789",
		})
		await rejects(() => Effect.runPromise(__testables.readBoundedJson(oversized, 8)), /exceeds 8 bytes/)

		const gate = new __testables.RequestQuiescenceGate()
		let releaseMaintenance!: () => void
		const maintenance = gate.exclusive(
			() =>
				new Promise<void>((resolve) => {
					releaseMaintenance = resolve
				}),
		)
		await Promise.resolve()
		const response = await serveWith(
			{
				prepareActivation: () => Effect.succeed({}),
				commitActivation: () => Effect.void,
				listActive: Effect.succeed([]),
			} as never,
			__testables.handleProjectionActivation(
				gate,
				"maintenance-secret",
				new Request("http://127.0.0.1/local/eventing/projections", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-maple-maintenance-token": "maintenance-secret",
					},
					body: "{}",
				}),
			),
		)
		strictEqual(response.status, 409)
		releaseMaintenance()
		await maintenance
	})

	it("separates consumer administration from claim and acknowledgement authorization", async () => {
		const gate = new __testables.RequestQuiescenceGate()
		const calls: string[] = []
		const eventing = {
			registerConsumer: (consumerId: string, startAt: string) =>
				Effect.sync(() => {
					calls.push(`register:${consumerId}:${startAt}`)
					return { consumerId, active: true }
				}),
			disableConsumer: (consumerId: string) =>
				Effect.sync(() => {
					calls.push(`disable:${consumerId}`)
					return { consumerId, active: false }
				}),
			claimReady: (consumerId: string, limit: number, leaseSeconds: number) =>
				Effect.sync(() => {
					calls.push(`claim:${consumerId}:${limit}:${leaseSeconds}`)
					return {
						consumerId,
						leaseToken: "a".repeat(64),
						throughSequence: 7,
						events: [{ sequence: 7, event: { id: "event-7" } }],
					}
				}),
			acknowledgeClaim: (consumerId: string, _leaseToken: string, throughSequence: number) =>
				Effect.sync(() => {
					calls.push(`ack:${consumerId}:${throughSequence}`)
					return { consumerId, acknowledgedThrough: throughSequence, prunedEvents: 0 }
				}),
		}

		const registration = await serveWith(
			eventing as never,
			__testables.handleConsumerRegistration(
				gate,
				"maintenance-secret",
				new Request("http://127.0.0.1/local/eventing/consumers", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-maple-maintenance-token": "maintenance-secret",
					},
					body: JSON.stringify({ consumerId: "automation", startAt: "beginning" }),
				}),
			),
		)
		strictEqual(registration.status, 201)

		const wrongClaimCredential = await serveWith(
			eventing as never,
			__testables.handleConsumerClaim(
				gate,
				"consumer-secret",
				new Request("http://127.0.0.1/local/eventing/claims", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-maple-maintenance-token": "maintenance-secret",
					},
					body: JSON.stringify({ consumerId: "automation", limit: 10, leaseSeconds: 30 }),
				}),
			),
		)
		strictEqual(wrongClaimCredential.status, 403)

		const claim = await serveWith(
			eventing as never,
			__testables.handleConsumerClaim(
				gate,
				"consumer-secret",
				new Request("http://127.0.0.1/local/eventing/claims", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-maple-event-consumer-token": "consumer-secret",
					},
					body: JSON.stringify({ consumerId: "automation", limit: 10, leaseSeconds: 30 }),
				}),
			),
		)
		strictEqual(claim.status, 200)
		const claimed = (await claim.json()) as { leaseToken: string; throughSequence: number }

		const acknowledgement = await serveWith(
			eventing as never,
			__testables.handleConsumerAcknowledgement(
				gate,
				"consumer-secret",
				new Request("http://127.0.0.1/local/eventing/acks", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-maple-event-consumer-token": "consumer-secret",
					},
					body: JSON.stringify({
						consumerId: "automation",
						leaseToken: claimed.leaseToken,
						throughSequence: claimed.throughSequence,
					}),
				}),
			),
		)
		strictEqual(acknowledgement.status, 200)
		deepStrictEqual(calls, [
			"register:automation:beginning",
			"claim:automation:10:30",
			"ack:automation:7",
		])

		let releaseMaintenance!: () => void
		const maintenance = gate.exclusive(
			() =>
				new Promise<void>((resolve) => {
					releaseMaintenance = resolve
				}),
		)
		await Promise.resolve()
		const blockedClaim = await serveWith(
			eventing as never,
			__testables.handleConsumerClaim(
				gate,
				"consumer-secret",
				new Request("http://127.0.0.1/local/eventing/claims", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-maple-event-consumer-token": "consumer-secret",
					},
					body: JSON.stringify({ consumerId: "automation", limit: 10, leaseSeconds: 30 }),
				}),
			),
		)
		strictEqual(blockedClaim.status, 503)
		releaseMaintenance()
		await maintenance
	})

	it("rejects fractional consumer limits before calling the store", async () => {
		const response = await serveWith(
			{
				claimReady: () => Effect.die(new Error("invalid input reached the store")),
			},
			__testables.handleConsumerClaim(
				new __testables.RequestQuiescenceGate(),
				"secret",
				new Request("http://127.0.0.1/local/eventing/claims", {
					method: "POST",
					headers: { "x-maple-event-consumer-token": "secret" },
					body: JSON.stringify({ consumerId: "automation", limit: 1.5, leaseSeconds: 30 }),
				}),
			),
		)
		strictEqual(response.status, 400)
	})

	it("isolates projection failures, stores telemetry, and makes sibling events ready", async () => {
		const order: string[] = []
		const event = { id: "event-1" }
		const db = {
			exec: () => {
				order.push("chdb-insert")
			},
		}
		const authority = {
			isRetired: () => false,
			filterBatch: (_datasource: string, ndjson: string) => {
				order.push("retention-filter")
				return { ndjson, accepted: 1, rejected: 0 }
			},
		}
		const eventing = {
			evaluateOtlp: () =>
				Effect.sync(() => {
					order.push("evaluate")
					return {
						events: [event],
						recoveredEventIds: [],
						failures: [
							{
								projectionId: "oversized-projector",
								projectionRevision: 1,
								occurrenceId: "occurrence-1",
								message: "CloudEvent exceeds 262144 UTF-8 bytes",
							},
						],
						typeMismatchFields: [],
					}
				}),
			persistFailures: () => Effect.sync(() => void order.push("persist-failures")),
			stage: () =>
				Effect.sync(() => {
					order.push("stage")
					return { inserted: 1, deduplicated: 0, dropped: 0, eventIds: [event.id] }
				}),
			markReady: () => Effect.sync(() => void order.push("ready")),
		}
		const request = new Request("http://127.0.0.1/v1/logs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				resourceLogs: [
					{
						scopeLogs: [
							{
								logRecords: [
									{
										timeUnixNano: "1786131720123456789",
										body: { stringValue: "one" },
									},
								],
							},
						],
					},
				],
			}),
		})

		const result = await serveWith(
			eventing as never,
			__testables.ingest(db as never, authority as never, "logs", request),
		)
		strictEqual(result.response.status, 200)
		strictEqual(result.accepted, 1)
		deepStrictEqual(order, [
			"evaluate",
			"persist-failures",
			"stage",
			"retention-filter",
			"chdb-insert",
			"ready",
		])
	})

	it("leaves a staged event non-ready when the warehouse write fails", async () => {
		let markedReady = false
		const request = new Request("http://127.0.0.1/v1/logs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "one" } }] }] }],
			}),
		})
		const result = await serveWith(
			{
				evaluateOtlp: () =>
					Effect.succeed({
						events: [{ id: "event-1" }],
						recoveredEventIds: [],
						failures: [],
						typeMismatchFields: [],
					}),
				persistFailures: () => Effect.void,
				stage: () =>
					Effect.succeed({ inserted: 1, deduplicated: 0, dropped: 0, eventIds: ["event-1"] }),
				markReady: () =>
					Effect.sync(() => {
						markedReady = true
					}),
			} as never,
			__testables.ingest(
				{
					exec: () => {
						throw new Error("write failed")
					},
				} as never,
				{
					isRetired: () => false,
					filterBatch: (_datasource: string, ndjson: string) => ({
						ndjson,
						accepted: 1,
						rejected: 0,
					}),
				} as never,
				"logs",
				request,
			),
		)
		strictEqual(result.response.status, 500)
		strictEqual(markedReady, false)
	})

	it("promotes recovered staged IDs only after the retry reaches the warehouse commit point", async () => {
		let readyIds: readonly string[] = []
		const request = new Request("http://127.0.0.1/v1/logs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				resourceLogs: [
					{
						scopeLogs: [
							{
								logRecords: [
									{ timeUnixNano: "1786131720123456789", body: { stringValue: "retry" } },
								],
							},
						],
					},
				],
			}),
		})
		const result = await serveWith(
			{
				evaluateOtlp: () =>
					Effect.succeed({
						events: [],
						recoveredEventIds: ["revision-1-event"],
						failures: [],
						typeMismatchFields: [],
					}),
				persistFailures: () => Effect.void,
				stage: () => Effect.succeed({ inserted: 0, deduplicated: 0, dropped: 0, eventIds: [] }),
				markReady: (eventIds: readonly string[]) =>
					Effect.sync(() => {
						readyIds = eventIds
					}),
			} as never,
			__testables.ingest(
				{ exec: () => undefined } as never,
				{
					isRetired: () => false,
					filterBatch: (_datasource: string, ndjson: string) => ({
						ndjson,
						accepted: 1,
						rejected: 0,
					}),
				} as never,
				"logs",
				request,
			),
		)
		strictEqual(result.response.status, 200)
		deepStrictEqual(readyIds, ["revision-1-event"])
	})

	it("accepts mixed OTLP batches while projecting only records with durable source time", async () => {
		let inserted = false
		let stagedIds: readonly string[] = []
		const body = {
			resourceLogs: [
				{
					scopeLogs: [
						{
							logRecords: [
								{
									timeUnixNano: "1786131720123456789",
									eventName: "project.me",
									body: { stringValue: "projectable" },
								},
								{
									eventName: "ignore.me",
									body: { stringValue: "timestamp-less" },
									attributes: Array.from({ length: 257 }, (_, index) => ({
										key: `projection-only-${index}`,
										value: { stringValue: "warehouse-valid" },
									})),
								},
								{
									timeUnixNano: "1786131721123456789",
									eventName: "ignore.me",
									body: { stringValue: "ordinary" },
								},
							],
						},
					],
				},
				{
					resource: {
						attributes: Array.from({ length: 257 }, (_, index) => ({
							key: `resource-projection-only-${index}`,
							value: { stringValue: "warehouse-valid" },
						})),
					},
					scopeLogs: [
						{
							logRecords: [
								{
									timeUnixNano: "1786131722123456789",
									eventName: "ignore.me",
								},
							],
						},
					],
				},
				{
					scopeLogs: [
						{
							scope: {
								attributes: Array.from({ length: 257 }, (_, index) => ({
									key: `scope-projection-only-${index}`,
									value: { stringValue: "warehouse-valid" },
								})),
							},
							logRecords: [
								{
									timeUnixNano: "1786131723123456789",
									eventName: "ignore.me",
								},
							],
						},
					],
				},
			],
		}
		const result = await serveWith(
			{
				evaluateOtlp: (_signal: string, decoded: unknown) => {
					const projected = run(normalizeOtlpLogs(decoded)).filter(
						(signal) => signal.fields.get("signal:event.name")?.value === "project.me",
					)
					return Effect.succeed({
						events: projected.map((_signal, index) => ({ id: `event-${index + 1}` })),
						recoveredEventIds: [],
						failures: [],
						typeMismatchFields: [],
					})
				},
				persistFailures: () => Effect.void,
				stage: (events: readonly { readonly id: string }[]) =>
					Effect.sync(() => {
						stagedIds = events.map(({ id }) => id)
						return { inserted: events.length, deduplicated: 0, dropped: 0, eventIds: stagedIds }
					}),
				markReady: () => Effect.void,
			} as never,
			__testables.ingest(
				{ exec: () => (inserted = true) } as never,
				{
					isRetired: () => false,
					filterBatch: (_datasource: string, ndjson: string) => ({
						ndjson,
						accepted: ndjson.trim().split("\n").length,
						rejected: 0,
					}),
				} as never,
				"logs",
				new Request("http://127.0.0.1/v1/logs", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			),
		)
		strictEqual(result.response.status, 200)
		strictEqual(result.accepted, 5)
		strictEqual(inserted, true)
		deepStrictEqual(stagedIds, ["event-1"])
	})

	it("refuses an in-batch source collision with 400 so exporters do not resend it", async () => {
		const ingestWith = (failure: Effect.Effect<never, unknown>) =>
			serveWith(
				{
					evaluateOtlp: () => failure,
				} as never,
				__testables.ingest(
					{ exec: () => undefined } as never,
					{ isRetired: () => false } as never,
					"logs",
					new Request("http://127.0.0.1/v1/logs", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ resourceLogs: [] }),
					}),
				),
			)
		const collision = await ingestWith(
			Effect.fail(
				new SourceOccurrenceCollision({ message: "source occurrence collision", occurrenceId: "a" }),
			),
		)
		strictEqual(collision.response.status, 400)
		strictEqual(collision.accepted, 0)
		const transient = await ingestWith(
			Effect.fail(new EventingControlStoreError({ message: "control store unavailable" })),
		)
		strictEqual(transient.response.status, 503)
		const unexpected = await ingestWith(Effect.die(new Error("projection crashed")))
		strictEqual(unexpected.response.status, 503)
	})

	it("reports a concurrent activation as a retryable 409", async () => {
		const request = new Request("http://127.0.0.1/local/eventing/projections", {
			method: "POST",
			headers: { "x-maple-maintenance-token": "maintenance-secret" },
			body: JSON.stringify({}),
		})
		const response = await serveWith(
			{
				prepareActivation: () => Effect.succeed({}),
				commitActivation: () =>
					Effect.fail(new ProjectionActivationConflict({ message: "projection registry changed" })),
			} as never,
			__testables.handleProjectionActivation(
				new __testables.RequestQuiescenceGate(),
				"maintenance-secret",
				request,
			),
		)
		strictEqual(response.status, 409)
	})

	it("validates outbox query parameters at the boundary and keeps store failures a 500", async () => {
		const read = async (query: string, eventing: Pick<LocalEventingRuntimeApi, "listReady">) => {
			const request = new Request(`http://127.0.0.1/local/eventing/outbox${query}`, {
				headers: { "x-maple-maintenance-token": "maintenance-secret" },
			})
			return serveWith(
				eventing as never,
				__testables.handleEventingRead("maintenance-secret", request, new URL(request.url)),
			)
		}
		const listed: Array<readonly [number, number]> = []
		const eventing = {
			listReady: (limit?: number, after?: number) =>
				Effect.sync(() => {
					listed.push([limit ?? 100, after ?? 0])
					return { events: [], nextCursor: null }
				}),
		}
		strictEqual((await read("?limit=0", eventing)).status, 400)
		strictEqual((await read("?limit=1.5", eventing)).status, 400)
		strictEqual((await read("?after=-1", eventing)).status, 400)
		strictEqual((await read("?state=acked", eventing)).status, 400)
		strictEqual((await read("?cursor=1", eventing)).status, 400)
		strictEqual((await read("?limit=25&after=7", eventing)).status, 200)
		deepStrictEqual(listed, [[25, 7]])
		const failing = {
			listReady: () => Effect.fail(new EventingControlStoreError({ message: "database is locked" })),
		}
		strictEqual((await read("", failing)).status, 500)
	})
})
