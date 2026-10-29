import { OrgId } from "@maple/domain"
import { Effect, Option, Schema } from "effect"
import { beforeAll, describe, expect, test } from "vitest"
import type { PageContext } from "./contract"
import * as Preload from "./preload"
import { pageIdentity, pageSlotId, preloadRoute, loadEveryPage } from "./registry"
import { AppRoute } from "../route"

// Pages enter only once their code is loaded (`loadPageCode`); these tests drive loaded pages.
beforeAll(() => Effect.runPromise(loadEveryPage))

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const TRACE = "6843a8853182b32339b2dd5120d423f2"
const traceRoute = AppRoute.Trace({ traceId: TRACE, search: {} })

const preloaded = () => preloadRoute(traceRoute, context, 0)
const keyOf = () => Option.getOrThrow(Preload.keyOfCommand(preloaded()[0]!))
const holder = pageIdentity({ _tag: "TraceDetail", key: TRACE, orgId, instance: 1 })

describe("intent preload", () => {
	test("a link's delay only fires while it is still hovered or focused", () => {
		const hovered = Option.getOrThrow(Preload.intended(Preload.init(), "/traces/a"))
		expect(Preload.intended(hovered.model, "/traces/a")).toEqual(Option.none())
		expect(Option.isSome(Preload.elapsed(hovered.model, "/traces/a", hovered.version))).toBe(true)
		const left = Preload.ended(hovered.model, "/traces/a")
		expect(Preload.elapsed(left, "/traces/a", hovered.version)).toEqual(Option.none())
	})

	test("the trace page preloads its span hierarchy only", () => {
		expect(preloaded().map((command) => command.name)).toEqual(["FetchSpanHierarchy"])
	})

	test("a page instance holds every key it asks for, and a new one releases the rest", () => {
		const entered = Preload.held(Preload.init(), holder, preloaded())
		expect(entered.model.heldKeys).toEqual([keyOf()])
		expect(entered.released).toEqual([])
		const again = Preload.held(entered.model, holder, preloaded())
		expect(again.model.heldKeys).toEqual([keyOf()])
		const left = Preload.held(entered.model, "Overview::org_acme", [])
		expect(left.released).toEqual([keyOf()])
		expect(left.model.heldKeys).toEqual([])
	})

	test("an open instance's new window releases the keys no slot stands on any more", () => {
		const nextWindow = preloadRoute(AppRoute.Trace({ traceId: "a".repeat(32), search: {} }), context, 0)
		const nextKey = Option.getOrThrow(Preload.keyOfCommand(nextWindow[0]!))
		const entered = Preload.held(Preload.init(), holder, preloaded(), () => [keyOf()])
		const moved = Preload.held(entered.model, holder, nextWindow, () =>
			Preload.liveKeysOf({ slot: { key: nextKey, data: { _tag: "Loading" } } }),
		)
		expect(moved.released).toEqual([keyOf()])
		expect(moved.model.heldKeys).toEqual([nextKey])
		const stillShown = Preload.held(entered.model, holder, nextWindow, () => [keyOf(), nextKey])
		expect(stillShown.released).toEqual([])
		expect(Preload.held(entered.model, holder, [], () => []).released).toEqual([])
	})

	test("a slot on a superseding re-read stands on the plain request key the cache stores", () => {
		const reread = `${keyOf()}\u00012`
		expect(Preload.liveKeysOf({ slot: { key: reread, data: { _tag: "Refreshing" } } })).toEqual([keyOf()])
	})

	test("an instance asking for nothing new does not walk its Model", () => {
		const entered = Preload.held(Preload.init(), holder, preloaded())
		const walked: Array<true> = []
		Preload.held(entered.model, holder, preloaded(), () => {
			walked.push(true)
			return []
		})
		expect(walked).toEqual([])
	})

	test("another org's instance on the same route gets its own view boundary", () => {
		const slot = { _tag: "ServicesList", key: "Services", orgId, instance: 1 }
		expect(pageSlotId({ ...slot, orgId: "org_other", instance: 2 })).not.toBe(pageSlotId(slot))
	})

	test("a key the next page asks for again is not released", () => {
		const entered = Preload.held(Preload.init(), holder, preloaded())
		const next = Preload.held(entered.model, "TraceDetail:other:org_acme", preloaded())
		expect(next.released).toEqual([])
	})

	test("a link under a resting pointer is not an entry; one the pointer moved onto is", () => {
		expect(Preload.isPointerEntry(Option.none(), 10, 20)).toBe(true)
		expect(Preload.isPointerEntry(Option.some({ x: 10, y: 20 }), 10, 20)).toBe(false)
		expect(Preload.isPointerEntry(Option.some({ x: 10, y: 19 }), 10, 20)).toBe(true)
	})

	test("after the hold, only preloads the open page does not hold are released", () => {
		expect(Preload.expired(Preload.init(), [keyOf()])).toEqual([keyOf()])
		const entered = Preload.held(Preload.init(), holder, preloaded()).model
		expect(Preload.expired(entered, [keyOf()])).toEqual([])
	})
})
