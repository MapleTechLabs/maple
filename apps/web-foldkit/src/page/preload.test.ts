import { OrgId } from "@maple/domain"
import { Option, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "./contract"
import * as Preload from "./preload"
import { pageIdentity, preloadRoute } from "./registry"
import { AppRoute } from "../route"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const TRACE = "6843a8853182b32339b2dd5120d423f2"
const traceRoute = AppRoute.Trace({ traceId: TRACE, search: {} })

const preloaded = () => preloadRoute(traceRoute, context, 0)
const keyOf = () => Option.getOrThrow(Preload.keyOfCommand(preloaded()[0]!))
const holder = pageIdentity({ _tag: "TraceDetail", key: TRACE, orgId })

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

	test("a key the next page asks for again is not released", () => {
		const entered = Preload.held(Preload.init(), holder, preloaded())
		const next = Preload.held(entered.model, "TraceDetail:other:org_acme", preloaded())
		expect(next.released).toEqual([])
	})

	test("after the hold, only preloads the open page does not hold are released", () => {
		expect(Preload.expired(Preload.init(), [keyOf()])).toEqual([keyOf()])
		const entered = Preload.held(Preload.init(), holder, preloaded()).model
		expect(Preload.expired(entered, [keyOf()])).toEqual([])
	})
})
