import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert"
import { Database } from "bun:sqlite"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "vitest"
import type { MapleCloudEvent, SignalProjectionSpec } from "@maple/eventing-core"
import { Effect } from "effect"
import {
	eventingControlPath,
	restoreControlSnapshot,
	validateControlSnapshot,
	writeControlSnapshot,
} from "../src/server/eventing/control-store"
import { metricRecorder, openStore, run, runAsync } from "./eventing-test-support"

const withDataDir = async (run: (dataDir: string) => Promise<void>): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-eventing-control-"))
	const dataDir = join(parent, "data")
	mkdirSync(dataDir, { recursive: true })
	try {
		await run(dataDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const projection = (overrides: Partial<SignalProjectionSpec> = {}): SignalProjectionSpec => ({
	id: "example-record-observed",
	revision: 1,
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

const event = (overrides: Partial<MapleCloudEvent> = {}): MapleCloudEvent => ({
	specversion: "1.0",
	id: "sha256:b01688f3c4a04b29206ff9d9949339b8fadc0de8fbf99c8282eae7e863c265e6",
	source: "urn:maple:source:otel:local",
	type: "dev.maple.example.record.observed.v1",
	subject: "records/42",
	time: "2026-08-07T19:42:00.123456789Z",
	datacontenttype: "application/json",
	dataschema: "urn:maple:event-schema:example-record:v1",
	tenantid: "tenant-a",
	projectionid: "example-record-observed",
	projectionrevision: 1,
	projectorid: "example.record",
	projectorversion: 1,
	data: { recordId: 42, label: "Example" },
	...overrides,
})

const SOURCE_FINGERPRINT = `sha256:${"a".repeat(64)}`

describe("LocalEventingControlStore", () => {
	it("records bounded outbox and consumer telemetry without identifiers or payloads", async () =>
		withDataDir(async (dataDir) => {
			const metrics = metricRecorder()
			const observed = <A, E>(effect: Effect.Effect<A, E>): A => run(metrics.observe(effect))
			const store = await openStore(dataDir)
			try {
				const sensitiveEvent = event({
					data: { recordId: 42, label: "PAYLOAD-MUST-NOT-BE-METRIC-DATA" },
				})
				observed(store.stageEvents([sensitiveEvent, sensitiveEvent]))
				throws(() => observed(store.stageEvents([event({ data: { recordId: 43 } })])), /collision/)
				throws(() => observed(store.markReady(["unknown-event-identifier"])), /unknown event/)
				observed(store.markReady([sensitiveEvent.id]))
				observed(store.registerConsumer("tenant-a", "private-consumer-identifier", "beginning"))
				const claim = observed(store.claimReady("tenant-a", "private-consumer-identifier", 10, 30))
				throws(
					() => observed(store.claimReady("tenant-a", "private-consumer-identifier", 10, 30)),
					/active lease/,
				)
				throws(
					() =>
						observed(
							store.acknowledgeClaim(
								"tenant-a",
								"private-consumer-identifier",
								"incorrect-private-token",
								claim.throughSequence!,
							),
						),
					/token does not match/,
				)
				observed(
					store.acknowledgeClaim(
						"tenant-a",
						"private-consumer-identifier",
						claim.leaseToken!,
						claim.throughSequence!,
					),
				)

				const operationOutcomes = metrics.operationOutcomes()
				for (const expected of [
					"outbox_stage:success",
					"outbox_stage:failure",
					"outbox_ready:success",
					"outbox_ready:failure",
					"outbox_dedup:success",
					"consumer_claim:success",
					"consumer_claim:failure",
					"consumer_ack:success",
					"consumer_ack:failure",
					"consumer_lease:failure",
					"consumer_lag:observed",
				])
					ok(operationOutcomes.includes(expected), `missing telemetry observation ${expected}`)

				const serialized = metrics.attributes()
				for (const forbidden of [
					"PAYLOAD-MUST-NOT-BE-METRIC-DATA",
					"private-consumer-identifier",
					"incorrect-private-token",
					sensitiveEvent.id,
					claim.leaseToken!,
				])
					strictEqual(serialized.includes(forbidden), false)
			} finally {
				await store.close()
			}
		}))

	it("stores immutable sequential revisions and only loads the active revision", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				run(store.saveProjection(projection()))
				deepStrictEqual(run(store.loadEnabledProjections("tenant-a")), [projection()])
				throws(
					() =>
						run(
							store.saveProjection(
								projection({ projector: { id: "changed", version: 1, config: {} } }),
							),
						),
					/immutable/,
				)
				throws(() => run(store.saveProjection(projection({ revision: 3 }))), /must be 2/)

				run(store.saveProjection(projection({ revision: 2, enabled: false })))
				deepStrictEqual(run(store.loadEnabledProjections("tenant-a")), [])
				run(store.saveProjection(projection({ revision: 3 })))
				deepStrictEqual(run(store.loadEnabledProjections("tenant-a")), [projection({ revision: 3 })])
				throws(
					() => run(store.saveProjection(projection({ revision: 2, enabled: false }))),
					/stale projection revision/,
				)
				throws(() => run(store.saveProjection(projection())), /stale projection revision/)
				run(store.saveProjection(projection({ revision: 3 })))
				deepStrictEqual(run(store.loadEnabledProjections("tenant-a")), [projection({ revision: 3 })])
				deepStrictEqual(run(store.validate), {
					schemaVersion: 1,
					projectionRevisions: 3,
					projectionFailures: 0,
					stagedEvents: 0,
					readyEvents: 0,
				})
			} finally {
				await store.close()
			}
		}))

	it("deduplicates staged events, rejects collisions, and preserves ready order", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				deepStrictEqual(run(store.stageEvents([event(), event()])), {
					inserted: 1,
					deduplicated: 1,
					dropped: 0,
					eventIds: [event().id, event().id],
				})
				throws(() => run(store.stageEvents([event({ data: { recordId: 43 } })])), /collision/)
				throws(() => run(store.markReady(["unknown"])), /unknown event/)
				run(store.markReady([event().id]))
				run(store.markReady([event().id]))
				deepStrictEqual(run(store.listStaged()).events, [])
				deepStrictEqual(
					run(store.listReady()).events.map(({ event }) => event),
					[event()],
				)
			} finally {
				await store.close()
			}
		}))

	it("binds staged source recovery to the normalized occurrence fingerprint", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				run(store.saveProjection(projection()))
				const sourced = event({ sourceoccurrenceid: "record-42" })
				throws(() => run(store.stageEvents([sourced])), /requires a source fingerprint/)
				run(store.stageEvents([sourced], new Map([[sourced.id, SOURCE_FINGERPRINT]])))
				deepStrictEqual(
					run(
						store.stagedEventIdsForOccurrence(
							sourced.tenantid,
							"otel.log",
							sourced.source,
							sourced.sourceoccurrenceid!,
							SOURCE_FINGERPRINT,
						),
					),
					[sourced.id],
				)
				throws(
					() =>
						run(
							store.stagedEventIdsForOccurrence(
								sourced.tenantid,
								"otel.log",
								sourced.source,
								sourced.sourceoccurrenceid!,
								`sha256:${"b".repeat(64)}`,
							),
						),
					/staged source occurrence collision/,
				)
				strictEqual(run(store.listStaged()).events.length, 1)
			} finally {
				await store.close()
			}
		}))

	it("survives restart and round-trips through a validated standalone snapshot", async () =>
		withDataDir(async (dataDir) => {
			let store = await openStore(dataDir)
			run(store.saveProjection(projection()))
			run(store.stageEvents([event()]))
			run(store.markReady([event().id]))
			run(
				store.recordProjectionFailures("tenant-a", [
					{
						projectionId: "example-record-observed",
						projectionRevision: 1,
						occurrenceId: "record-42",
						message: "test failure",
					},
				]),
			)
			await store.close()

			store = await openStore(dataDir)
			deepStrictEqual(run(store.loadEnabledProjections("tenant-a")), [projection()])
			deepStrictEqual(
				run(store.listReady()).events.map(({ event }) => event),
				[event()],
			)
			const snapshot = join(dataDir, "backups", "snapshot", "control.sqlite")
			const validation = await runAsync(store.backupTo(snapshot))
			deepStrictEqual(validation, {
				schemaVersion: 1,
				projectionRevisions: 1,
				projectionFailures: 1,
				stagedEvents: 0,
				readyEvents: 1,
			})
			await store.close()

			const restored = join(dataDir, "restored")
			await runAsync(restoreControlSnapshot(snapshot, restored))
			deepStrictEqual(run(validateControlSnapshot(eventingControlPath(restored))), validation)
			const restoredStore = await openStore(restored)
			try {
				deepStrictEqual(run(restoredStore.loadEnabledProjections("tenant-a")), [projection()])
				deepStrictEqual(
					run(restoredStore.listReady()).events.map(({ event }) => event),
					[event()],
				)
			} finally {
				await restoredStore.close()
			}
		}))

	it("writes the captured SQLite state even when the live store changes before archive I/O", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				run(store.saveProjection(projection()))
				run(store.stageEvents([event()]))
				const bytes = run(store.captureSnapshot)
				run(store.markReady([event().id]))
				run(store.saveProjection(projection({ revision: 2, enabled: false })))
				const snapshot = join(dataDir, "backups", "captured", "control.sqlite")
				const validation = await runAsync(writeControlSnapshot(snapshot, bytes))
				strictEqual(validation.stagedEvents, 1)
				strictEqual(validation.readyEvents, 0)
				strictEqual(validation.projectionRevisions, 1)
				strictEqual(run(store.validate).readyEvents, 1)
				strictEqual(run(store.validate).projectionRevisions, 2)
				const restored = join(dataDir, "restored-capture")
				await runAsync(restoreControlSnapshot(snapshot, restored))
				const recovered = await openStore(restored)
				try {
					deepStrictEqual(run(recovered.loadEnabledProjections("tenant-a")), [projection()])
					deepStrictEqual(
						run(recovered.listStaged()).events.map((row) => row.event),
						[event()],
					)
				} finally {
					await recovered.close()
				}
			} finally {
				await store.close()
			}
		}))

	it("checkpoints committed live WAL state before serializing", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				run(store.saveProjection(projection()))
				run(store.stageEvents([event()]))
				run(store.markReady([event().id]))
				const walPath = `${eventingControlPath(dataDir)}-wal`
				ok(existsSync(walPath))
				ok(statSync(walPath).size > 0, "test requires uncheckpointed WAL frames")

				const snapshot = join(dataDir, "backups", "live-wal", "control.sqlite")
				await runAsync(store.backupTo(snapshot))
				strictEqual(statSync(walPath).size, 0)

				const restored = join(dataDir, "restored-live-wal")
				await runAsync(restoreControlSnapshot(snapshot, restored))
				const restoredStore = await openStore(restored)
				try {
					deepStrictEqual(run(restoredStore.loadEnabledProjections("tenant-a")), [projection()])
					deepStrictEqual(
						run(restoredStore.listReady()).events.map(({ event }) => event),
						[event()],
					)
				} finally {
					await restoredStore.close()
				}
			} finally {
				await store.close()
			}
		}))

	it("paginates every ready event and reports bounded outbox overflow", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir, {
				maxOutboxEvents: 2,
				maxOutboxBytes: 1024 * 1024,
			})
			try {
				const second = event({ id: "event-2", data: { recordId: 43, label: "Second" } })
				const third = event({ id: "event-3", data: { recordId: 44, label: "Third" } })
				const staged = run(store.stageEvents([event(), second]))
				run(store.markReady(staged.eventIds))

				const firstPage = run(store.listReady(1))
				strictEqual(firstPage.events.length, 1)
				strictEqual(firstPage.nextCursor, firstPage.events[0]?.sequence)
				const secondPage = run(store.listReady(1, firstPage.nextCursor!))
				deepStrictEqual(
					[...firstPage.events, ...secondPage.events].map(({ event }) => event.id),
					[event().id, second.id],
				)
				strictEqual(secondPage.nextCursor, null)
				deepStrictEqual(run(store.stageEvents([event()])).deduplicated, 1)
				deepStrictEqual(run(store.stageEvents([third])), {
					inserted: 0,
					deduplicated: 0,
					dropped: 1,
					eventIds: [],
				})
				strictEqual(run(store.deliveryGap("tenant-a")).generation, 1)
			} finally {
				await store.close()
			}
		}))

	it("pages recovered events by first readiness transition instead of staging order", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			try {
				const first = event({ id: "event-a" })
				const second = event({ id: "event-b" })
				run(store.stageEvents([first]))
				run(store.stageEvents([second]))
				run(store.markReady([second.id]))

				const initialPage = run(store.listReady(1))
				deepStrictEqual(
					initialPage.events.map(({ event }) => event.id),
					[second.id],
				)
				const cursor = initialPage.events[0]!.sequence

				run(store.markReady([first.id]))
				const recoveredPage = run(store.listReady(1, cursor))
				deepStrictEqual(
					recoveredPage.events.map(({ event }) => event.id),
					[first.id],
				)
				strictEqual(recoveredPage.events[0]!.sequence > cursor, true)
			} finally {
				await store.close()
			}
		}))

	it("rejects invalid schema-1 staged fingerprints during snapshot validation", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			run(store.saveProjection(projection()))
			const missing = event({ id: "event-missing-fingerprint", sourceoccurrenceid: "record-1" })
			const malformed = event({ id: "event-malformed-fingerprint", sourceoccurrenceid: "record-2" })
			run(
				store.stageEvents(
					[missing, malformed],
					new Map([
						[missing.id, SOURCE_FINGERPRINT],
						[malformed.id, SOURCE_FINGERPRINT],
					]),
				),
			)
			await store.close()

			const database = new Database(eventingControlPath(dataDir), {
				readwrite: true,
				strict: true,
				safeIntegers: true,
			})
			database.run("UPDATE outbox_events SET source_fingerprint = NULL WHERE event_id = ?", [
				missing.id,
			])
			database.run("UPDATE outbox_events SET source_fingerprint = ? WHERE event_id = ?", [
				"sha256:not-a-digest",
				malformed.id,
			])
			database.close(true)

			throws(
				() => run(validateControlSnapshot(eventingControlPath(dataDir))),
				/invalid staged source fingerprint/,
			)
			await rejects(() => openStore(dataDir), /invalid staged source fingerprint/)
		}))

	it("leases whole batches, redelivers after expiry, and rejects stale acknowledgements", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir, {
				maxOutboxEvents: 10,
				maxOutboxBytes: 1024 * 1024,
				retainAcknowledgedReadyEvents: 0,
			})
			try {
				const second = event({ id: "event-2" })
				const third = event({ id: "event-3" })
				const staged = run(store.stageEvents([event(), second, third]))
				run(store.markReady(staged.eventIds))
				run(store.registerConsumer("tenant-a", "automation", "beginning", "2026-08-13T12:00:00.000Z"))

				const firstClaim = run(
					store.claimReady("tenant-a", "automation", 2, 10, "2026-08-13T12:00:01.000Z"),
				)
				strictEqual(firstClaim.leaseToken?.length, 64)
				deepStrictEqual(
					firstClaim.events.map(({ event }) => event.id),
					[event().id, second.id],
				)
				throws(
					() => run(store.claimReady("tenant-a", "automation", 2, 10, "2026-08-13T12:00:02.000Z")),
					/active lease/,
				)
				throws(
					() =>
						run(
							store.acknowledgeClaim(
								"tenant-a",
								"automation",
								"0".repeat(64),
								firstClaim.throughSequence!,
								"2026-08-13T12:00:03.000Z",
							),
						),
					/token does not match/,
				)
				throws(
					() =>
						run(
							store.acknowledgeClaim(
								"tenant-a",
								"automation",
								firstClaim.leaseToken!,
								firstClaim.events[0]!.sequence,
								"2026-08-13T12:00:03.000Z",
							),
						),
					/complete claimed batch/,
				)

				const retry = run(
					store.claimReady("tenant-a", "automation", 2, 10, "2026-08-13T12:00:12.000Z"),
				)
				deepStrictEqual(
					retry.events.map(({ event }) => event.id),
					[event().id, second.id],
				)
				strictEqual(retry.leaseToken === firstClaim.leaseToken, false)
				deepStrictEqual(
					run(
						store.acknowledgeClaim(
							"tenant-a",
							"automation",
							retry.leaseToken!,
							retry.throughSequence!,
							"2026-08-13T12:00:13.000Z",
						),
					),
					{
						consumerId: "automation",
						acknowledgedThrough: retry.throughSequence,
						prunedEvents: 2,
					},
				)
				deepStrictEqual(
					run(store.listReady()).events.map(({ event }) => event.id),
					[third.id],
				)
				throws(
					() =>
						run(
							store.acknowledgeClaim(
								"tenant-a",
								"automation",
								firstClaim.leaseToken!,
								firstClaim.throughSequence!,
								"2026-08-13T12:00:14.000Z",
							),
						),
					/no active lease/,
				)
			} finally {
				await store.close()
			}
		}))

	it("prunes only after every active consumer advances and never prunes staged events", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir, {
				maxOutboxEvents: 10,
				maxOutboxBytes: 1024 * 1024,
				retainAcknowledgedReadyEvents: 0,
			})
			try {
				const second = event({ id: "event-2" })
				const third = event({ id: "event-3" })
				const stranded = event({ id: "event-staged" })
				const ready = run(store.stageEvents([event(), second, third]))
				run(store.markReady(ready.eventIds))
				run(store.stageEvents([stranded]))
				run(store.registerConsumer("tenant-a", "automation-a", "beginning"))
				run(store.registerConsumer("tenant-a", "automation-b", "beginning"))

				const fast = run(store.claimReady("tenant-a", "automation-a", 3, 30))
				strictEqual(
					run(
						store.acknowledgeClaim(
							"tenant-a",
							"automation-a",
							fast.leaseToken!,
							fast.throughSequence!,
						),
					).prunedEvents,
					0,
				)
				const slow = run(store.claimReady("tenant-a", "automation-b", 2, 30))
				strictEqual(
					run(
						store.acknowledgeClaim(
							"tenant-a",
							"automation-b",
							slow.leaseToken!,
							slow.throughSequence!,
						),
					).prunedEvents,
					2,
				)
				deepStrictEqual(
					run(store.listReady()).events.map(({ event }) => event.id),
					[third.id],
				)
				run(store.disableConsumer("tenant-a", "automation-b"))
				deepStrictEqual(run(store.listReady()).events, [])
				deepStrictEqual(
					run(store.listStaged()).events.map(({ event }) => event.id),
					[stranded.id],
				)
			} finally {
				await store.close()
			}
		}))

	it("starts latest consumers after backlog and checkpoints active leases", async () =>
		withDataDir(async (dataDir) => {
			let store = await openStore(dataDir)
			run(store.stageEvents([event()]))
			run(store.markReady([event().id]))
			const registered = run(
				store.registerConsumer("tenant-a", "automation", "latest", "2099-01-01T00:00:00.000Z"),
			)
			strictEqual(registered.lastAcknowledgedSequence, run(store.listReady()).events[0]!.sequence)
			deepStrictEqual(
				run(store.claimReady("tenant-a", "automation", 10, 300, "2099-01-01T00:00:01.000Z")).events,
				[],
			)

			const second = event({ id: "event-2" })
			run(store.stageEvents([second]))
			run(store.markReady([second.id]))
			const claim = run(store.claimReady("tenant-a", "automation", 10, 300, "2099-01-01T00:00:02.000Z"))
			const snapshot = join(dataDir, "backups", "consumer", "control.sqlite")
			await runAsync(store.backupTo(snapshot))
			await store.close()

			const restored = join(dataDir, "restored-consumer")
			await runAsync(restoreControlSnapshot(snapshot, restored))
			store = await openStore(restored)
			try {
				deepStrictEqual(
					run(store.listConsumers("tenant-a"))[0]?.claimedThroughSequence,
					claim.throughSequence,
				)
				strictEqual(
					run(
						store.acknowledgeClaim(
							"tenant-a",
							"automation",
							claim.leaseToken!,
							claim.throughSequence!,
							"2099-01-01T00:00:03.000Z",
						),
					).acknowledgedThrough,
					claim.throughSequence,
				)
			} finally {
				await store.close()
			}
		}))

	it("rejects a corrupted durable outbox counter at reopen", async () =>
		withDataDir(async (dataDir) => {
			const store = await openStore(dataDir)
			run(store.stageEvents([event()]))
			await store.close()
			const db = new Database(eventingControlPath(dataDir))
			try {
				db.run("UPDATE outbox_usage SET bytes = bytes + 1 WHERE singleton = 1")
			} finally {
				db.close()
			}
			await rejects(() => openStore(dataDir), /accounting is inconsistent/)
		}))

	it("refuses a symlink in place of the database", async () =>
		withDataDir(async (dataDir) => {
			const controlPath = eventingControlPath(dataDir)
			mkdirSync(join(dataDir, "control"), { recursive: true })
			symlinkSync(join(dataDir, "target.sqlite"), controlPath)
			await rejects(() => openStore(dataDir), /not a real file/)
			strictEqual(controlPath.endsWith("control/eventing.sqlite"), true)
		}))
})
