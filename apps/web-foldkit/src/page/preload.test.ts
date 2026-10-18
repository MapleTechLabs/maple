import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "./contract"
import { toLoadFailure } from "../data/load-failure"
import * as Preload from "./preload"
import { pageIdentity, preloadRoute, type PageMessage } from "./registry"
import { AppRoute } from "../route"
import { Message as TraceMessage } from "./traces/detail/message"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const TRACE = "6843a8853182b32339b2dd5120d423f2"
const traceRoute = AppRoute.Trace({ traceId: TRACE, search: {} })

const preloaded = () => preloadRoute(traceRoute, context, 0)
const keyOf = () => Option.getOrThrow(Preload.keyOfCommand(preloaded()[0]!))
const answer = (key: string): PageMessage => ({
	_tag: "TraceDetail",
	message: TraceMessage.CompletedFetchHierarchy({
		key,
		result: Result.fail(toLoadFailure(new Error("held"))),
	}),
})
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

	test("a key already preloaded or held by the open page is not sent again", () => {
		const first = Preload.started(Preload.init(), preloaded())
		expect(first.keys).toEqual([keyOf()])
		expect(Preload.started(first.model, preloaded()).commands).toEqual([])
		const held = Preload.seeded(Preload.init(), holder, preloaded()).model
		expect(Preload.started(held, preloaded()).commands).toEqual([])
	})

	test("a settled preload is delivered to the page instead of fetched", () => {
		const started = Preload.started(Preload.init(), preloaded()).model
		const settled = Option.getOrThrow(Preload.answered(started, answer(keyOf())))
		expect(settled.forward).toEqual(Option.none())
		const entered = Preload.seeded(settled.model, holder, preloaded())
		expect(entered.commands).toEqual([])
		expect(entered.delivered).toEqual([answer(keyOf())])
		expect(entered.model.entries).toEqual({})
	})

	test("an in-flight preload is awaited, then forwarded to the page", () => {
		const started = Preload.started(Preload.init(), preloaded()).model
		const entered = Preload.seeded(started, holder, preloaded())
		expect(entered.commands).toEqual([])
		expect(entered.delivered).toEqual([])
		const landed = Option.getOrThrow(Preload.answered(entered.model, answer(keyOf())))
		expect(landed.forward).toEqual(Option.some(answer(keyOf())))
		expect(Preload.expired(entered.model, [keyOf()]).entries).toEqual(entered.model.entries)
	})

	test("an answer handed over by another page is delivered on entry and never preloaded again", () => {
		const handed = Preload.handedOff(Preload.init(), [answer(keyOf())])
		expect(handed.keys).toEqual([keyOf()])
		expect(Preload.started(handed.model, preloaded()).commands).toEqual([])
		const entered = Preload.seeded(handed.model, holder, preloaded())
		expect(entered.commands).toEqual([])
		expect(entered.delivered).toEqual([answer(keyOf())])
	})

	test("an unused preload is released after the hold", () => {
		const started = Preload.started(Preload.init(), preloaded()).model
		expect(Preload.expired(started, [keyOf()]).entries).toEqual({})
	})
})
