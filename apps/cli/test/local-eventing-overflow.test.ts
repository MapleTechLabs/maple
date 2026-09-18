import { ProjectorRegistry } from "@maple/eventing-core"
import { Result, Schema } from "effect"
import { strictEqual, throws } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "vitest"
import { RetiredDayAuthority } from "../src/server/archives/retention"
import { __testables } from "../src/server/serve"
import { makeRuntime, openStore, run, serveWith } from "./eventing-test-support"

describe("Durable outbox overflow", () => {
	it("keeps warehouse ingestion available and requires explicit gap recovery across reopen", async () => {
		const parent = mkdtempSync(join(tmpdir(), "maple-overflow-"))
		const dataDir = join(parent, "data")
		mkdirSync(dataDir)
		const store = await openStore(dataDir, {
			maxOutboxEvents: 1,
			maxOutboxBytes: 1024 * 1024,
		})
		try {
			const projectors = Result.getOrThrow(
				new ProjectorRegistry().register({
					id: "example.observed",
					version: 1,
					sourceKinds: ["otel.log"],
					outputType: "dev.maple.example.observed.v1",
					dataSchema: "urn:maple:event-schema:observed:v1",
					decodeConfig: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Never)),
					decodeOutput: Schema.decodeUnknownSync(Schema.Struct({ observed: Schema.Boolean })),
					project: () => ({ data: { observed: true } }),
				}),
			)
			const runtime = makeRuntime(store, projectors)
			run(
				runtime.activate({
					id: "observed",
					revision: 1,
					enabled: true,
					tenantId: "local",
					sourceKind: "otel.log",
					selector: {
						op: "exists",
						field: { namespace: "signal", key: "event.name", type: "string" },
					},
					projector: { id: "example.observed", version: 1, config: {} },
					activeFrom: "1970-01-01T00:00:00Z",
				}),
			)
			const statements: string[] = []
			const warehouse = {
				exec: (sql: string) => {
					statements.push(sql)
				},
			}
			const authority = new RetiredDayAuthority(dataDir)
			const ingest = (id: string) =>
				serveWith(
					runtime,
					__testables.ingest(
						warehouse,
						authority,
						"logs",
						new Request("http://localhost/v1/logs", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								resourceLogs: [
									{
										scopeLogs: [
											{
												logRecords: [
													{
														eventName: "example.observed",
														timeUnixNano: "1786131720123456789",
														attributes: [
															{ key: "event.id", value: { stringValue: id } },
														],
													},
												],
											},
										],
									},
								],
							}),
						}),
					),
				)
			const first = await ingest("record-1")
			strictEqual(first.accepted, 1)
			strictEqual(first.response.status, 200)
			const second = await ingest("record-2")
			strictEqual(second.accepted, 1)
			strictEqual(second.response.status, 200)
			strictEqual(second.response.headers.get("x-maple-eventing-dropped"), "1")
			strictEqual(statements.length, 2)
			const retained = run(store.listReady(10)).events
			strictEqual(retained.length, 1)
			const eventId = retained[0]?.event.id
			if (eventId === undefined) throw new Error("missing retained event")
			run(store.registerConsumer("local", "consumer", "beginning"))
			throws(() => run(store.claimReady("local", "consumer", 10, 60)), /delivery has a gap/)
			throws(() => run(store.acceptDeliveryGap("local", "consumer", 2)), /generation changed/)
			run(store.acceptDeliveryGap("local", "consumer", 1))
			strictEqual(run(store.claimReady("local", "consumer", 10, 60)).events.length, 1)
			throws(() => run(store.abandonEvents("other-tenant", [eventId])), /unknown event ID/)
			throws(() => run(store.abandonEvents("local", [eventId, "missing"])), /unknown event ID/)
			strictEqual(run(store.listReady(10)).events.length, 1)
			strictEqual(run(store.deliveryGap("local")).generation, 1)
			const unauthorized = await serveWith(
				runtime,
				__testables.handleOutboxAdministration(
					new __testables.RequestQuiescenceGate(),
					"secret",
					new Request("http://localhost/local/eventing/outbox/abandon", {
						method: "POST",
						body: JSON.stringify({ eventIds: [eventId] }),
					}),
					"abandon",
				),
			)
			strictEqual(unauthorized.status, 403)
			strictEqual(run(store.listReady(10)).events.length, 1)
			const gate = new __testables.RequestQuiescenceGate()
			const release = gate.enter()
			if (release === null) throw new Error("gate unexpectedly closed")
			const pending = serveWith(
				runtime,
				__testables.handleOutboxAdministration(
					gate,
					"secret",
					new Request("http://localhost/local/eventing/outbox/abandon", {
						method: "POST",
						headers: { "x-maple-maintenance-token": "secret" },
						body: JSON.stringify({ eventIds: [eventId] }),
					}),
					"abandon",
				),
			)
			await Promise.resolve()
			strictEqual(run(store.listReady(10)).events.length, 1)
			release()
			strictEqual((await pending).status, 200)
			strictEqual(run(store.deliveryGap("local")).generation, 2)
			throws(() => run(store.claimReady("local", "consumer", 10, 60)), /delivery has a gap/)
			run(store.acceptDeliveryGap("local", "consumer", 2))
			// Abandonment cleared the old lease and transactional counters free capacity.
			const third = await ingest("record-3")
			strictEqual(third.accepted, 1)
			strictEqual(third.response.headers.get("x-maple-eventing-dropped"), null)
			strictEqual(run(store.claimReady("local", "consumer", 10, 60)).events.length, 1)
			run(store.validate)
		} finally {
			await store.close()
		}
		try {
			const reopened = await openStore(dataDir)
			try {
				strictEqual(run(reopened.deliveryGap("local")).generation, 2)
				strictEqual(run(reopened.deliveryGap("local")).droppedEvents, 2)
				strictEqual(run(reopened.listReady(10)).events.length, 1)
			} finally {
				await reopened.close()
			}
		} finally {
			rmSync(parent, { recursive: true, force: true })
		}
	})
})
