import { Option, Result } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import * as Slot from "./slot"

const morning = Slot.keyOf("sessions", { startTime: "06:00" })
const evening = Slot.keyOf("sessions", { startTime: "12:00" })

const requested = (slot: Slot.Slot<number>, key: string, force = false) => Option.getOrThrow(Slot.request(slot, key, force))
const loaded = (key: string, data: number, atMs: number) => Slot.accept(requested(Slot.idle(), key), key, Result.succeed(data), atMs)

describe("local query slots", () => {
	test("a superseded answer is dropped, the current one lands with its time", () => {
		const second = requested(requested(Slot.idle<number>(), morning), evening)
		const afterLate = Slot.accept(second, morning, Result.succeed(1), 100)
		expect(afterLate).toEqual(second)
		const current = Slot.accept(afterLate, evening, Result.succeed(2), 200)
		expect(current.data).toEqual(AsyncData.Success({ data: 2 }))
		expect(current.updatedAtMs).toBe(200)
	})

	test("asking again for the slot's key starts nothing unless forced", () => {
		const done = loaded(morning, 1, 100)
		expect(Slot.request(done, morning)).toEqual(Option.none())
		expect(requested(done, morning, true).data).toEqual(AsyncData.Refreshing({ data: 1 }))
	})

	test("a new key keeps the previous rows as a placeholder; its failure drops them", () => {
		const switched = requested(loaded(morning, 1, 100), evening)
		expect(switched.isPlaceholder).toBe(true)
		expect(Slot.accept(switched, evening, Result.fail({ message: "timeout" })).data).toEqual(
			AsyncData.Failure({ error: { message: "timeout" } }),
		)
	})

	test("a failed refetch keeps the rows beside the error and their time", () => {
		const refetching = requested(loaded(morning, 1, 100), morning, true)
		const failed = Slot.accept(refetching, morning, Result.fail({ message: "timeout" }), 200)
		expect(failed.data).toEqual(AsyncData.Stale({ data: 1, error: { message: "timeout" } }))
		expect(failed.updatedAtMs).toBe(100)
	})

	test("a cached answer for another key, or after a fetch filled the slot, is ignored", () => {
		const pending = requested(Slot.idle<number>(), morning)
		const cached = { data: 9, updatedAtMs: 50, isStandIn: true }
		expect(Slot.acceptCached(pending, evening, cached, false)).toEqual(pending)
		const done = Slot.accept(pending, morning, Result.succeed(1), 100)
		expect(Slot.acceptCached(done, morning, cached, false)).toEqual(done)
		const shown = Slot.acceptCached(pending, morning, cached, false)
		expect(shown.data).toEqual(AsyncData.Refreshing({ data: 9 }))
		expect(shown.isStandIn).toBe(true)
	})
})
