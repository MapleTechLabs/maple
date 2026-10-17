import { Option, Result } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import * as Keyed from "./keyed"
import { requestKey } from "./request-key"

const morning = requestKey("org_a", "getServicesFacets", { data: { startTime: "06:00", endTime: "18:00" } })
const evening = requestKey("org_a", "getServicesFacets", { data: { startTime: "12:00", endTime: "24:00" } })
const otherOrg = requestKey("org_b", "getServicesFacets", { data: { startTime: "12:00", endTime: "24:00" } })

const requested = (slot: Keyed.Keyed<number, string>, key: string, mode: Keyed.RequestMode = "Load") =>
	Option.getOrThrow(Keyed.request(slot, key, mode))

const loaded = (key: string, data: number) =>
	Keyed.accept(requested(Keyed.idle(), key), key, Result.succeed(data))

describe("request keys", () => {
	test("the same input in any key order, with or without undefined fields, is the same request", () => {
		expect(requestKey("org_a", "q", { b: 1, a: { d: undefined, c: [2] } })).toBe(
			requestKey("org_a", "q", { a: { c: [2] }, b: 1 }),
		)
		expect(requestKey("org_a", "q", { a: 1 })).not.toBe(requestKey("org_b", "q", { a: 1 }))
	})
})

describe("Keyed slots", () => {
	test("a superseded answer is dropped, the current one lands", () => {
		const first = requested(Keyed.idle<number, string>(), morning)
		const second = requested(first, evening)
		const afterLate = Keyed.accept(second, morning, Result.succeed(1))
		expect(afterLate).toEqual(second)
		expect(Keyed.accept(afterLate, evening, Result.succeed(2)).data).toEqual(
			AsyncData.Success({ data: 2 }),
		)
	})

	test("asking again for a pending or loaded key starts nothing; a refresh revalidates", () => {
		const pending = requested(Keyed.idle<number, string>(), morning)
		expect(Keyed.request(pending, morning, "Load")).toEqual(Option.none())
		const done = Keyed.accept(pending, morning, Result.succeed(1))
		expect(Keyed.request(done, morning, "Load")).toEqual(Option.none())
		expect(requested(done, morning, "Refresh").data).toEqual(AsyncData.Refreshing({ data: 1 }))
	})

	test("a new window keeps the previous data on screen; a new org does not", () => {
		const done = loaded(morning, 1)
		expect(requested(done, evening).data).toEqual(AsyncData.Refreshing({ data: 1 }))
		expect(requested(done, otherOrg).data).toEqual(AsyncData.Loading())
	})

	test("a failed refresh keeps the last data beside the error", () => {
		const refreshing = requested(loaded(morning, 1), morning, "Refresh")
		expect(Keyed.accept(refreshing, morning, Result.fail("timeout")).data).toEqual(
			AsyncData.Stale({ data: 1, error: "timeout" }),
		)
	})
})
