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

	test("a new key's failure shows the error, not the previous key's rows", () => {
		const switched = requested(loaded(morning, 1), evening)
		expect(Keyed.accept(switched, evening, Result.fail("timeout")).data).toEqual(
			AsyncData.Failure({ error: "timeout" }),
		)
		const settled = Keyed.accept(switched, evening, Result.succeed(2))
		const refreshed = requested(settled, evening, "Refresh")
		expect(Keyed.accept(refreshed, evening, Result.fail("timeout")).data).toEqual(
			AsyncData.Stale({ data: 2, error: "timeout" }),
		)
	})

	test("a retry of a failed key keeps the failure on screen until the answer lands", () => {
		const failed = Keyed.accept(
			requested(Keyed.idle<number, string>(), morning),
			morning,
			Result.fail("timeout"),
		)
		const retrying = requested(failed, morning, "Refresh")
		expect(retrying.data).toEqual(AsyncData.Failure({ error: "timeout" }))
		expect(Keyed.request(retrying, morning, "Refresh")).toEqual(Option.none())
		expect(Keyed.request(retrying, morning, "Load")).toEqual(Option.none())
		expect(Keyed.accept(retrying, morning, Result.fail("still down")).data).toEqual(
			AsyncData.Failure({ error: "still down" }),
		)
		const recovered = Keyed.accept(retrying, morning, Result.succeed(3))
		expect(recovered.data).toEqual(AsyncData.Success({ data: 3 }))
		expect(requested(Keyed.accept(retrying, morning, Result.fail("again")), morning).data).toEqual(
			AsyncData.Failure({ error: "again" }),
		)
	})

	test("a new window after a failure loads fresh; a parked failure loads from scratch", () => {
		const failed = Keyed.accept(
			requested(Keyed.idle<number, string>(), morning),
			morning,
			Result.fail("timeout"),
		)
		expect(requested(failed, evening).data).toEqual(AsyncData.Loading())
		expect(requested(Keyed.forgetFailure(failed), morning).data).toEqual(AsyncData.Loading())
	})

	test("a post-write re-read supersedes the read in flight: the older answer is dropped", () => {
		const reloading = requested(loaded(morning, 1), morning, "Refresh")
		const superseded = Keyed.supersede(reloading, morning)
		expect(superseded.key).not.toBe(morning)
		const afterOld = Keyed.accept(superseded, morning, Result.succeed(1))
		expect(afterOld).toEqual(superseded)
		const key = superseded.key
		expect(Keyed.accept(afterOld, key, Result.succeed(2)).data).toEqual(AsyncData.Success({ data: 2 }))
		expect(Keyed.request(Keyed.accept(afterOld, key, Result.succeed(2)), morning, "Load")).toEqual(
			Option.none(),
		)
		expect(Keyed.supersede(superseded, morning).key).not.toBe(key)
	})

	test("a later poll or retry keeps the superseding generation: the pre-write answer stays dropped", () => {
		const superseded = Keyed.supersede(requested(loaded(morning, 1), morning, "Refresh"), morning)
		const landed = Keyed.accept(superseded, superseded.key, Result.succeed(2))
		const polled = requested(landed, morning, "Refresh")
		expect(polled.key).toBe(superseded.key)
		expect(Keyed.accept(polled, morning, Result.succeed(1))).toEqual(polled)
		const failed = Keyed.accept(polled, polled.key, Result.fail("timeout"))
		const retried = requested(failed, morning, "Refresh")
		expect(Keyed.accept(retried, morning, Result.succeed(1))).toEqual(retried)
		expect(Keyed.accept(retried, retried.key, Result.succeed(3)).data).toEqual(
			AsyncData.Success({ data: 3 }),
		)
	})

	test("requestFor: `Supersede` always re-reads, the other modes defer to `request`", () => {
		const pending = requested(Keyed.idle<number, string>(), morning)
		expect(Keyed.requestFor(pending, morning, "Load")).toEqual(Option.none())
		expect(Keyed.requestFor(pending, morning, "Refresh")).toEqual(
			Keyed.request(pending, morning, "Refresh"),
		)
		const superseded = Option.getOrThrow(Keyed.requestFor(pending, morning, "Supersede"))
		expect(Keyed.accept(superseded, morning, Result.succeed(1))).toEqual(superseded)
		expect(Keyed.accept(superseded, superseded.key, Result.succeed(2)).data).toEqual(
			AsyncData.Success({ data: 2 }),
		)
	})
})

describe("Keyed slots that track their data's age", () => {
	const cached = { data: 9, updatedAtMs: 50, isStandIn: true }

	test("a success records its fetch time; a failed refresh keeps the shown data's", () => {
		const done = Keyed.accept(requested(Keyed.idle<number, string>(), morning), morning, Result.succeed(1), 100)
		expect(done.updatedAtMs).toBe(100)
		const failed = Keyed.accept(requested(done, morning, "Refresh"), morning, Result.fail("timeout"), 200)
		expect([failed.data, failed.updatedAtMs]).toEqual([AsyncData.Stale({ data: 1, error: "timeout" }), 100])
	})

	test("a cached answer for another key, or after a fetch filled the slot, is ignored", () => {
		const pending = requested(Keyed.idle<number, string>(), morning)
		expect(Keyed.acceptCached(pending, evening, cached, false)).toEqual(pending)
		const done = Keyed.accept(pending, morning, Result.succeed(1), 100)
		expect(Keyed.acceptCached(done, morning, cached, false)).toEqual(done)
		const shown = Keyed.acceptCached(pending, morning, cached, false)
		expect([shown.data, shown.isStandIn, shown.updatedAtMs]).toEqual([AsyncData.Refreshing({ data: 9 }), true, 50])
		expect(Keyed.acceptCached(pending, morning, cached, true).data).toEqual(AsyncData.Success({ data: 9 }))
	})

	test("a stand-in stays one through its own refetch and its failure, and ends with its key's answer", () => {
		const shown = Keyed.acceptCached(requested(Keyed.idle<number, string>(), morning), morning, cached, false)
		expect(Keyed.accept(shown, morning, Result.fail("timeout")).isStandIn).toBe(true)
		expect(Keyed.accept(shown, morning, Result.succeed(2), 300)).toEqual({
			key: morning,
			data: AsyncData.Success({ data: 2 }),
			updatedAtMs: 300,
		})
		expect(requested(shown, evening).isStandIn).toBeUndefined()
	})

	test("a cached answer replaces another key's retained data, which cannot be extended", () => {
		const switched = requested(Keyed.accept(requested(Keyed.idle<number, string>(), morning), morning, Result.succeed(1)), evening)
		expect(Keyed.canExtend(switched)).toBe(false)
		const shown = Keyed.acceptCached(switched, evening, { ...cached, isStandIn: false }, true)
		expect([shown.retained, Keyed.canExtend(shown)]).toEqual([undefined, true])
	})
})

describe("requestKeepingFailure", () => {
	test("a load under a failed key asks nothing; a refresh retries with the failure on screen", () => {
		const failed = Keyed.accept(requested(Keyed.idle<number, string>(), morning), morning, Result.fail("timeout"))
		expect(Keyed.requestKeepingFailure(failed, morning, "Load")).toEqual(Option.none())
		expect(Option.getOrThrow(Keyed.requestKeepingFailure(failed, morning, "Refresh")).data).toEqual(
			AsyncData.Failure({ error: "timeout" }),
		)
		expect(Option.getOrThrow(Keyed.requestKeepingFailure(failed, evening, "Load")).data).toEqual(AsyncData.Loading())
	})

	test("pending, failed, retrying and in-flight slots read as such", () => {
		const pending = requested(Keyed.idle<number, string>(), morning)
		expect([Keyed.isAwaitingFirstData(pending), Keyed.isInFlight(pending)]).toEqual([true, true])
		const failed = Keyed.accept(pending, morning, Result.fail("timeout"))
		expect([Keyed.isAwaitingFirstData(failed), Keyed.failureWithoutData(failed)]).toEqual([false, Option.some("timeout")])
		const retrying = requested(failed, morning, "Refresh")
		expect([Keyed.isInFlight(failed), Keyed.isInFlight(retrying)]).toEqual([false, true])
		const stale = Keyed.accept(requested(loaded(morning, 1), morning, "Refresh"), morning, Result.fail("timeout"))
		expect(Keyed.failureWithoutData(stale)).toEqual(Option.none())
	})
})
