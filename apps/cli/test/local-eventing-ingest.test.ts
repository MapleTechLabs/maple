import { deepStrictEqual, ok, strictEqual } from "node:assert"
import { gzipSync } from "node:zlib"
import { CloudEventInvalid } from "@maple/eventing-core"
import { Result } from "effect"
import { describe, it } from "vitest"
import { normalizeOtlpLogs } from "../src/server/eventing/otlp"
import { OutboxEventRejected } from "../src/server/eventing/control-store"
import { ProjectionActivationConflict, SourceOccurrenceCollision } from "../src/server/eventing/runtime"
import { __testables } from "../src/server/serve"

describe("Local eventing ingest seam", () => {
	it("requires maintenance authorization and exposes staged records only when requested", async () => {
		const eventing = {
			health: () => ({ activeProjections: 1 }),
			listActive: () => [],
			listReady: () => ({ events: [{ sequence: 1, event: { id: "ready" } }], nextCursor: null }),
			listStaged: (_limit: number, after: number) => ({
				events: [{ sequence: after + 1, event: { id: "staged" } }],
				nextCursor: null,
			}),
		}
		const unauthorized = __testables.handleEventingRead(
			eventing as never,
			"maintenance-secret",
			new Request("http://127.0.0.1/local/eventing/outbox?state=staged"),
			new URL("http://127.0.0.1/local/eventing/outbox?state=staged"),
		)
		strictEqual(unauthorized.status, 403)

		const request = new Request("http://127.0.0.1/local/eventing/outbox?state=staged&after=41", {
			headers: { "x-maple-maintenance-token": "maintenance-secret" },
		})
		const authorized = __testables.handleEventingRead(
			eventing as never,
			"maintenance-secret",
			request,
			new URL(request.url),
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
		const unauthorized = await __testables.handleProjectionActivation(
			{} as never,
			gate,
			"maintenance-secret",
			{
				headers: new Headers(),
				body: neverClosed,
			} as Request,
		)
		strictEqual(unauthorized.status, 403)
		const afterUnauthorized = gate.enter()
		ok(afterUnauthorized, "invalid authorization must not close admission")
		afterUnauthorized()

		const checkpointUnauthorized = await __testables.handleCheckpointBackup(
			{} as never,
			{} as never,
			"/unused",
			gate,
			"maintenance-secret",
			{ headers: new Headers(), body: neverClosed } as Request,
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
		const pending = __testables.handleProjectionActivation(
			{
				prepareActivation: (body: unknown) => ({ body }),
				commitActivation: () => {
					committed = true
				},
				listActive: () => [],
			} as never,
			gate,
			"maintenance-secret",
			{
				headers: new Headers({ "x-maple-maintenance-token": "maintenance-secret" }),
				body: slowBody,
			} as Request,
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
		const bounded = await __testables.readBoundedJson(oversized, 8)
		ok(Result.isFailure(bounded) && /exceeds 8 bytes/.test(bounded.failure.message))

		const gate = new __testables.RequestQuiescenceGate()
		let releaseMaintenance!: () => void
		const maintenance = gate.exclusive(
			() =>
				new Promise<void>((resolve) => {
					releaseMaintenance = resolve
				}),
		)
		await Promise.resolve()
		const response = await __testables.handleProjectionActivation(
			{
				prepareActivation: () => ({}),
				commitActivation: () => undefined,
				listActive: () => [],
			} as never,
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
		)
		strictEqual(response.status, 409)
		releaseMaintenance()
		await maintenance
	})

	it("separates consumer administration from claim and acknowledgement authorization", async () => {
		const gate = new __testables.RequestQuiescenceGate()
		const calls: string[] = []
		const eventing = {
			registerConsumer: (consumerId: string, startAt: string) => {
				calls.push(`register:${consumerId}:${startAt}`)
				return { consumerId, active: true }
			},
			disableConsumer: (consumerId: string) => {
				calls.push(`disable:${consumerId}`)
				return { consumerId, active: false }
			},
			claimReady: (consumerId: string, limit: number, leaseSeconds: number) => {
				calls.push(`claim:${consumerId}:${limit}:${leaseSeconds}`)
				return {
					consumerId,
					leaseToken: "a".repeat(64),
					throughSequence: 7,
					events: [{ sequence: 7, event: { id: "event-7" } }],
				}
			},
			acknowledgeClaim: (consumerId: string, _leaseToken: string, throughSequence: number) => {
				calls.push(`ack:${consumerId}:${throughSequence}`)
				return { consumerId, acknowledgedThrough: throughSequence, prunedEvents: 0 }
			},
		}

		const registration = await __testables.handleConsumerRegistration(
			eventing as never,
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
		)
		strictEqual(registration.status, 201)

		const wrongClaimCredential = await __testables.handleConsumerClaim(
			eventing as never,
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
		)
		strictEqual(wrongClaimCredential.status, 403)

		const claim = await __testables.handleConsumerClaim(
			eventing as never,
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
		)
		strictEqual(claim.status, 200)
		const claimed = (await claim.json()) as { leaseToken: string; throughSequence: number }

		const acknowledgement = await __testables.handleConsumerAcknowledgement(
			eventing as never,
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
		const blockedClaim = await __testables.handleConsumerClaim(
			eventing as never,
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
		)
		strictEqual(blockedClaim.status, 503)
		releaseMaintenance()
		await maintenance
	})

	it("rejects fractional consumer limits before calling the store", async () => {
		const response = await __testables.handleConsumerClaim(
			{
				claimReady: () => {
					throw new Error("invalid input reached the store")
				},
			},
			new __testables.RequestQuiescenceGate(),
			"secret",
			new Request("http://127.0.0.1/local/eventing/claims", {
				method: "POST",
				headers: { "x-maple-event-consumer-token": "secret" },
				body: JSON.stringify({ consumerId: "automation", limit: 1.5, leaseSeconds: 30 }),
			}),
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
			evaluateOtlp: () => {
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
			},
			persistFailures: () => order.push("persist-failures"),
			stage: () => {
				order.push("stage")
				return { inserted: 1, deduplicated: 0, dropped: 0, eventIds: [event.id] }
			},
			markReady: () => order.push("ready"),
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

		const result = await __testables.ingest(
			db as never,
			authority as never,
			eventing as never,
			"logs",
			request,
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
		const result = await __testables.ingest(
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
			{
				evaluateOtlp: () => ({
					events: [{ id: "event-1" }],
					recoveredEventIds: [],
					failures: [],
					typeMismatchFields: [],
				}),
				persistFailures: () => undefined,
				stage: () => ({ inserted: 1, deduplicated: 0, dropped: 0, eventIds: ["event-1"] }),
				markReady: () => {
					markedReady = true
				},
			} as never,
			"logs",
			request,
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
		const result = await __testables.ingest(
			{ exec: () => undefined } as never,
			{
				isRetired: () => false,
				filterBatch: (_datasource: string, ndjson: string) => ({
					ndjson,
					accepted: 1,
					rejected: 0,
				}),
			} as never,
			{
				evaluateOtlp: () => ({
					events: [],
					recoveredEventIds: ["revision-1-event"],
					failures: [],
					typeMismatchFields: [],
				}),
				persistFailures: () => undefined,
				stage: () => ({ inserted: 0, deduplicated: 0, dropped: 0, eventIds: [] }),
				markReady: (eventIds: readonly string[]) => {
					readyIds = eventIds
				},
			} as never,
			"logs",
			request,
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
		const result = await __testables.ingest(
			{ exec: () => (inserted = true) } as never,
			{
				isRetired: () => false,
				filterBatch: (_datasource: string, ndjson: string) => ({
					ndjson,
					accepted: ndjson.trim().split("\n").length,
					rejected: 0,
				}),
			} as never,
			{
				evaluateOtlp: (_signal: string, decoded: unknown) => {
					const projected = normalizeOtlpLogs(decoded).filter(
						(signal) => signal.fields.get("signal:event.name")?.value === "project.me",
					)
					return {
						events: projected.map((_signal, index) => ({ id: `event-${index + 1}` })),
						recoveredEventIds: [],
						failures: [],
						typeMismatchFields: [],
					}
				},
				persistFailures: () => undefined,
				stage: (events: readonly { readonly id: string }[]) => {
					stagedIds = events.map(({ id }) => id)
					return { inserted: events.length, deduplicated: 0, dropped: 0, eventIds: stagedIds }
				},
				markReady: () => undefined,
			} as never,
			"logs",
			new Request("http://127.0.0.1/v1/logs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		)
		strictEqual(result.response.status, 200)
		strictEqual(result.accepted, 5)
		strictEqual(inserted, true)
		deepStrictEqual(stagedIds, ["event-1"])
	})

	it("refuses an in-batch source collision with 400 so exporters do not resend it", async () => {
		const ingestWith = (failure: unknown) =>
			__testables.ingest(
				{ exec: () => undefined } as never,
				{ isRetired: () => false } as never,
				{
					evaluateOtlp: () => {
						throw failure
					},
				} as never,
				"logs",
				new Request("http://127.0.0.1/v1/logs", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ resourceLogs: [] }),
				}),
			)
		const collision = await ingestWith(
			new SourceOccurrenceCollision({ message: "source occurrence collision", occurrenceId: "a" }),
		)
		strictEqual(collision.response.status, 400)
		strictEqual(collision.accepted, 0)
		const transient = await ingestWith(new Error("control store unavailable"))
		strictEqual(transient.response.status, 503)
	})

	it("refuses outbox collisions and invalid events with 400 so exporters do not resend them", async () => {
		const stageWith = (failure: unknown) =>
			__testables.ingest(
				{ exec: () => undefined } as never,
				{ isRetired: () => false } as never,
				{
					evaluateOtlp: () => ({
						events: [{ id: "event-1" }],
						recoveredEventIds: [],
						failures: [],
						typeMismatchFields: [],
					}),
					persistFailures: () => undefined,
					stage: () => {
						throw failure
					},
				} as never,
				"logs",
				new Request("http://127.0.0.1/v1/logs", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ resourceLogs: [] }),
				}),
			)
		const collision = await stageWith(
			new OutboxEventRejected({
				message: "event ID collision with different payload",
				eventId: "event-1",
			}),
		)
		strictEqual(collision.response.status, 400)
		const invalid = await stageWith(new CloudEventInvalid({ message: "bad envelope", cause: null }))
		strictEqual(invalid.response.status, 400)
		strictEqual((await stageWith(new Error("database is locked"))).response.status, 503)
	})

	it("acknowledges committed rows when outbox readiness fails and retries readiness", async () => {
		const retried: Array<readonly string[]> = []
		const result = await __testables.ingest(
			{ exec: () => undefined } as never,
			{
				isRetired: () => false,
				filterBatch: (_datasource: string, ndjson: string) => ({ ndjson, accepted: 1, rejected: 0 }),
			} as never,
			{
				evaluateOtlp: () => ({
					events: [{ id: "event-1" }],
					recoveredEventIds: [],
					failures: [],
					typeMismatchFields: [],
				}),
				persistFailures: () => undefined,
				stage: () => ({ inserted: 1, deduplicated: 0, dropped: 0, eventIds: ["event-1"] }),
				markReady: () => {
					throw new Error("database is locked")
				},
			} as never,
			"logs",
			new Request("http://127.0.0.1/v1/logs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "one" } }] }] }],
				}),
			}),
			{ retry: (eventIds) => retried.push(eventIds) },
		)
		// A 503 here made exporters resend rows that were already inserted.
		strictEqual(result.response.status, 200)
		strictEqual(result.accepted, 1)
		deepStrictEqual(retried, [["event-1"]])
	})

	it("refuses a gzip bomb instead of inflating it", () => {
		const bomb = gzipSync(new Uint8Array(4096))
		const refused = __testables.decodeOtlp("logs", bomb, "application/x-protobuf", "gzip", 1024)
		ok(Result.isFailure(refused))
		strictEqual(refused.failure._tag, "@maple/cli/OtlpBodyTooLarge")
		const accepted = __testables.decodeOtlp("logs", gzipSync("{}"), "application/json", "gzip", 1024)
		ok(Result.isSuccess(accepted))
	})

	it("reports a concurrent activation as a retryable 409", async () => {
		const request = new Request("http://127.0.0.1/local/eventing/projections", {
			method: "POST",
			headers: { "x-maple-maintenance-token": "maintenance-secret" },
			body: JSON.stringify({}),
		})
		const response = await __testables.handleProjectionActivation(
			{
				prepareActivation: () => ({}),
				commitActivation: () => {
					throw new ProjectionActivationConflict({ message: "projection registry changed" })
				},
			} as never,
			new __testables.RequestQuiescenceGate(),
			"maintenance-secret",
			request,
		)
		strictEqual(response.status, 409)
	})

	it("validates outbox query parameters at the boundary and keeps store failures a 500", async () => {
		const read = (query: string, eventing: Pick<LocalEventingRuntime, "listReady">) => {
			const request = new Request(`http://127.0.0.1/local/eventing/outbox${query}`, {
				headers: { "x-maple-maintenance-token": "maintenance-secret" },
			})
			return __testables.handleEventingRead(
				eventing as never,
				"maintenance-secret",
				request,
				new URL(request.url),
			)
		}
		const listed: Array<readonly [number, number]> = []
		const eventing = {
			listReady: (limit: number, after: number) => {
				listed.push([limit, after])
				return { events: [], nextCursor: null }
			},
		}
		strictEqual(read("?limit=0", eventing).status, 400)
		strictEqual(read("?limit=1.5", eventing).status, 400)
		strictEqual(read("?after=-1", eventing).status, 400)
		strictEqual(read("?state=acked", eventing).status, 400)
		strictEqual(read("?cursor=1", eventing).status, 400)
		strictEqual(read("?limit=25&after=7", eventing).status, 200)
		deepStrictEqual(listed, [[25, 7]])
		const failing = {
			listReady: () => {
				throw new Error("database is locked")
			},
		}
		strictEqual(read("", failing).status, 500)
	})
})
