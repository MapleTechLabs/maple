import * as ServiceMap from "@maple/web/service-map/map/service-map"
import { Option } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { toParentMessage } from "foldkit/test"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import type { ServiceMapPageBlock } from "./block"
import { FetchServiceMap, ReadClock, ReadStored, SaveViewPrefs } from "./command"
import { MapBinding } from "./composition"
import type { LocalServiceMapData } from "./data"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { type ServiceMapViewInputs, view as pageView } from "./view"

const NOW = Date.parse("2026-10-01T12:00:30Z")

const context: PageContext = {
	env: { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false },
	location: { path: "/service-map", search: "" },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
}
const inputs: ServiceMapViewInputs = {
	context,
	maybePresence: Option.some({
		rows: [{ signal: "traces", status: "absent", lastSeenMs: null }],
		nowMs: NOW,
	}),
	lastIngestAtMs: Option.none(),
}
const view = withViewInputs(pageView, inputs)()
/** Every Message the page's graph accepts: its own and its children's generated delivery. */
type PageMessage = typeof ServiceMapPageBlock.Message.Type
const pageUpdate = (model: Model, message: PageMessage) => update(model, message, context)
/** A map fact, delivered the way the embedded map's own view would send it. */
const toMap = (message: ServiceMap.Message) => toParentMessage(MapBinding, message)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

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

const mapData = (edges: LocalServiceMapData["edges"]): LocalServiceMapData => ({
	edges,
	dbEdges: [],
	overviews: [],
	platforms: new Map(),
	runtimes: new Map(),
})
const twoServices = mapData([edge("storefront", "checkout-api")])
const noServices = mapData([])

/** Entered, anchored and the stored state read: the map request in flight. */
const requested = (): Model => {
	const anchored = pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW })).model
	return pageUpdate(
		anchored,
		Message.CompletedReadStored({
			stored: { prefs: { minTrafficPct: 0, collapsedNamespaces: [] }, snapshots: [] },
		}),
	).model
}

const answered = (data: LocalServiceMapData) => {
	const base = requested()
	return pageUpdate(
		base,
		Message.SucceededFetchServiceMap({ key: base.data.key ?? "", data, fetchedAtMs: NOW }),
	)
}

const mapOf = (model: Model) => Option.getOrThrow(model.maybeMap)

describe("local service map", () => {
	test("entry reads the clock and the stored layout, then asks the map once", () => {
		expect(names(init(context).commands)).toEqual(
			expect.arrayContaining([ReadClock.name, ReadStored.name]),
		)
		const anchored = pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW }))
		expect((anchored.commands ?? []).map(({ name }) => name)).toEqual([FetchServiceMap.name])
	})

	test("an answer for a superseded key is dropped and builds no map", () => {
		const base = requested()
		const stale = pageUpdate(
			base,
			Message.SucceededFetchServiceMap({ key: "stale", data: twoServices, fetchedAtMs: NOW }),
		)
		expect(stale.model.data).toEqual(base.data)
		expect(Option.isNone(stale.model.maybeMap)).toBe(true)
	})

	test("a new window reads the result cache first; an older window stands in while it refetches", () => {
		const base = requested()
		const anchored = pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW }))
		expect((anchored.commands ?? []).map(({ args }) => args)).toMatchObject([{ readsCache: true }])
		const cached = { data: twoServices, updatedAtMs: NOW - 3_600_000, isStandIn: true, isFresh: false }
		const found = pageUpdate(base, Message.FoundCachedServiceMap({ key: base.data.key ?? "", cached }))
		expect(mapOf(found.model).source.services).toEqual(["checkout-api", "storefront"])
		expect(found.model.data.isStandIn).toBe(true)
		const refetches = (found.commands ?? []).filter(({ name }) => name === FetchServiceMap.name)
		expect(refetches.map(({ args }) => args)).toMatchObject([{ key: base.data.key, readsCache: false }])
	})

	test("a fresh cached window is shown without a fetch", () => {
		const base = requested()
		const cached = { data: twoServices, updatedAtMs: NOW, isStandIn: false, isFresh: true }
		const found = pageUpdate(base, Message.FoundCachedServiceMap({ key: base.data.key ?? "", cached }))
		expect((found.commands ?? []).map(({ name }) => name)).not.toContain(FetchServiceMap.name)
		expect(found.model.data.updatedAtMs).toBe(NOW)
	})

	test("rows build the graph: two services, one connection, no databases", () => {
		const map = mapOf(answered(twoServices).model)
		expect(map.source.services).toEqual(["checkout-api", "storefront"])
		expect(map.source.rawNodes.length).toBe(2)
	})

	test("an empty map asks for signal presence and renders the on-ramp", () => {
		const result = answered(noServices)
		expect(result.outMessage).toEqual(PageOutMessage.RequestedSignalPresence())
		scene(
			{ update: pageUpdate, view },
			given(result.model),
			expectView(text("No services yet")).toExist(),
		)
	})

	test("focusing a selected service keeps the prefs; showing all traffic is saved", () => {
		const loaded = answered(twoServices).model
		const selected = pageUpdate(loaded, toMap(ServiceMap.Message.ClickedNode({ nodeId: "storefront" })))
		const focused = pageUpdate(selected.model, Message.ClickedFocusSelected())
		expect(Option.map(mapOf(focused.model).focus, (focus) => focus.serviceId)).toEqual(
			Option.some("storefront"),
		)
		expect((focused.commands ?? []).map(({ name }) => name)).not.toContain(SaveViewPrefs.name)
		const filtered = {
			...focused.model,
			maybeMap: Option.some({ ...mapOf(focused.model), minTrafficPct: 5 }),
		}
		const reset = pageUpdate(filtered, toMap(ServiceMap.Message.ClickedShowAllTraffic()))
		expect(mapOf(reset.model).minTrafficPct).toBe(0)
		expect((reset.commands ?? []).map(({ name }) => name)).toContain(SaveViewPrefs.name)
	})
})
