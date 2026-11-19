import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { TestClock } from "effect/testing"
import {
	type ArchiveMessage,
	type ArchivePorts,
	AuditArchiveForwardError,
	AuditArchiveWriteError,
	processArchiveBatch,
	UNATTRIBUTED_ORG,
} from "./archive"

const MAX_RETRIES = 5
// 2026-11-19T10:00:00Z
const NOW_MS = Date.UTC(2026, 10, 19, 10)

const message = (id: string, body: unknown, attempts = 1) => {
	const state = { acked: false, retried: false }
	const value: ArchiveMessage = {
		id,
		body,
		attempts,
		ack: () => {
			state.acked = true
		},
		retry: () => {
			state.retried = true
		},
	}
	return { value, state }
}

const fakePorts = (fail: { put?: boolean; forward?: boolean } = {}) => {
	const objects = new Map<string, string>()
	const forwarded: Array<unknown> = []
	let next = 0
	const ports: ArchivePorts = {
		putObject: (key, body) =>
			fail.put === true
				? Effect.fail(new AuditArchiveWriteError({ message: "r2 down", key }))
				: objects.has(key)
					? Effect.fail(new AuditArchiveWriteError({ message: "locked", key }))
					: Effect.sync(() => {
							objects.set(key, body)
						}),
		forward: (bodies) =>
			fail.forward === true
				? Effect.fail(new AuditArchiveForwardError({ message: "queue down" }))
				: Effect.sync(() => {
						forwarded.push(...bodies)
					}),
		newBatchId: Effect.sync(() => `batch-${++next}`),
	}
	return { ports, objects, forwarded }
}

const run = (messages: ReadonlyArray<ArchiveMessage>, ports: ArchivePorts) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW_MS)
		const fiber = yield* Effect.forkChild(processArchiveBatch(messages, MAX_RETRIES, ports))
		yield* Fiber.join(fiber)
	})

const ArchiveLine = Schema.Struct({ messageId: Schema.String, body: Schema.Unknown })
const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(ArchiveLine))
const parseLines = (ndjson: string) => Arr.map(Str.split("\n")(Str.trim(ndjson)), (line) => decodeLine(line))
const batchless = (key: string) => Str.replace(/batch-\d+/, "<id>")(key)

describe("processArchiveBatch", () => {
	it.effect(
		"writes one NDJSON object per org under audit/<org>/<yyyy>/<mm>/<dd>, then forwards and acks",
		() =>
			Effect.gen(function* () {
				const a1 = message("m1", { orgId: "org_a", id: "e1", action: "dashboard.created" })
				const a2 = message("m2", { orgId: "org_a", id: "e2", action: "dashboard.deleted" })
				const b1 = message("m3", { orgId: "org_b", id: "e3", action: "api_key.created" })
				const fake = fakePorts()
				yield* run([a1.value, a2.value, b1.value], fake.ports)

				const byKey = Rec.fromEntries(
					Arr.map([...fake.objects], ([key, body]) => [batchless(key), parseLines(body)] as const),
				)
				expect(byKey).toEqual({
					"audit/org_a/2026/11/19/<id>.ndjson": [
						{ messageId: "m1", body: a1.value.body },
						{ messageId: "m2", body: a2.value.body },
					],
					"audit/org_b/2026/11/19/<id>.ndjson": [{ messageId: "m3", body: b1.value.body }],
				})
				expect(fake.forwarded).toHaveLength(3)
				expect([a1.state, a2.state, b1.state]).toEqual([
					{ acked: true, retried: false },
					{ acked: true, retried: false },
					{ acked: true, retried: false },
				])
			}),
	)

	it.effect("keeps a body with no usable org under the unattributed prefix", () =>
		Effect.gen(function* () {
			const odd = message("m1", { orgId: "../../escape", id: "e1" })
			const fake = fakePorts()
			yield* run([odd.value], fake.ports)
			expect(Arr.map([...fake.objects.keys()], (key) => Str.split("/")(key)[1])).toEqual([
				UNATTRIBUTED_ORG,
			])
			expect(odd.state.acked).toBe(true)
		}),
	)

	it.effect("does not forward or ack when the archive write fails, and retries instead", () =>
		Effect.gen(function* () {
			const entry = message("m1", { orgId: "org_a", id: "e1" })
			const fake = fakePorts({ put: true })
			yield* run([entry.value], fake.ports)
			expect({ forwarded: fake.forwarded, state: entry.state }).toEqual({
				forwarded: [],
				state: { acked: false, retried: true },
			})
		}),
	)

	it.effect("retries when forwarding fails; the redelivery writes a new object beside the first", () =>
		Effect.gen(function* () {
			const first = message("m1", { orgId: "org_a", id: "e1" })
			const fake = fakePorts({ forward: true })
			yield* run([first.value], fake.ports)
			expect(first.state).toEqual({ acked: false, retried: true })

			const redelivered = message("m1", { orgId: "org_a", id: "e1" }, 2)
			yield* run([redelivered.value], { ...fake.ports, forward: () => Effect.void })
			expect({ objects: fake.objects.size, acked: redelivered.state.acked }).toEqual({
				objects: 2,
				acked: true,
			})
		}),
	)
})
