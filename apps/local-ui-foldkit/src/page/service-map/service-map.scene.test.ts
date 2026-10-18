import * as ServiceMap from "@maple/web-foldkit/service-map/map/service-map"
import { Option } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { FetchServiceMap, ReadClock, ReadStored, SaveViewPrefs } from "./command"
import { LocalServiceMapData } from "./fetch"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const NOW = Date.parse("2026-10-01T12:00:30Z")

const context: PageContext = {
	env: { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false },
	location: { path: "/service-map", search: "" },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
}
const inputs: PageViewInputs = {
	context,
	presenceOf: () => Option.some({ signal: "traces", status: "absent", lastSeenMs: null }),
	presenceNowMs: NOW,
	hasNewDataSince: () => false,
}
const view = withViewInputs(pageView, inputs)()
const pageUpdate = (model: Model, message: Message) => update(model, message, context)

const edge = (sourceService: string, targetService: string) => ({
	sourceService,
	targetService,
	callCount: 30,
	estimatedCallCount: 30,
	errorCount: 0,
	errorRate: 0,
	avgDurationMs: 12,
	maxDurationMs: 40,
	hasSampling: false,
	samplingWeight: 1,
})

const twoServices = new LocalServiceMapData([edge("storefront", "checkout-api")], [], [], new Map(), new Map())
const noServices = new LocalServiceMapData([], [], [], new Map(), new Map())

/** Entered, anchored and the stored state read: the map request in flight. */
const requested = (): Model => {
	const anchored = pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW })).model
	return pageUpdate(anchored, Message.CompletedReadStored({ stored: { prefs: { minTrafficPct: 0, collapsedNamespaces: [] }, snapshots: [] } })).model
}

const answered = (data: LocalServiceMapData) => {
	const base = requested()
	return pageUpdate(base, Message.SucceededFetchServiceMap({ key: base.data.key ?? "", data, fetchedAtMs: NOW }))
}

const mapOf = (model: Model) => Option.getOrThrow(model.maybeMap)

describe("local service map", () => {
	test("entry reads the clock and the stored layout, then asks the map once", () => {
		expect(init(context).commands.map(({ name }) => name)).toEqual([ReadClock.name, ReadStored.name])
		const anchored = pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW }))
		expect((anchored.commands ?? []).map(({ name }) => name)).toEqual([FetchServiceMap.name])
	})

	test("an answer for a superseded key is dropped and builds no map", () => {
		const base = requested()
		const stale = pageUpdate(base, Message.SucceededFetchServiceMap({ key: "stale", data: twoServices, fetchedAtMs: NOW }))
		expect(stale.model.data).toEqual(base.data)
		expect(Option.isNone(stale.model.maybeMap)).toBe(true)
	})

	test("rows build the graph: two services, one connection, no databases", () => {
		const map = mapOf(answered(twoServices).model)
		expect(map.source.services).toEqual(["checkout-api", "storefront"])
		expect(map.source.rawNodes.length).toBe(2)
	})

	test("an empty map asks for signal presence and renders the on-ramp", () => {
		const result = answered(noServices)
		expect(result.outMessage).toEqual(PageOutMessage.RequestedSignalPresence())
		scene({ update: pageUpdate, view }, given(result.model), expectView(text("No services yet")).toExist())
	})

	test("focusing a selected service keeps the prefs; showing all traffic is saved", () => {
		const loaded = answered(twoServices).model
		const selected = pageUpdate(loaded, Message.GotMapMessage({ message: ServiceMap.Message.ClickedNode({ nodeId: "storefront" }) }))
		const focused = pageUpdate(selected.model, Message.GotMapMessage({ message: ServiceMap.Message.ClickedFocusSelected() }))
		expect(Option.map(mapOf(focused.model).focus, (focus) => focus.serviceId)).toEqual(Option.some("storefront"))
		expect((focused.commands ?? []).map(({ name }) => name)).not.toContain(SaveViewPrefs.name)
		const filtered = { ...focused.model, maybeMap: Option.some({ ...mapOf(focused.model), minTrafficPct: 5 }) }
		const reset = pageUpdate(filtered, Message.GotMapMessage({ message: ServiceMap.Message.ClickedShowAllTraffic() }))
		expect(mapOf(reset.model).minTrafficPct).toBe(0)
		expect((reset.commands ?? []).map(({ name }) => name)).toContain(SaveViewPrefs.name)
	})
})
