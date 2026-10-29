import { Option } from "effect"
import { click, expect as expectView, expectOutMessage, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import { FetchCatalog, ReadClock } from "./command"
import { Message } from "./message"
import type { Model, ServiceCatalogEntry } from "./model"
import type { ServicesBlock } from "./block"
import { init, update } from "./update"
import { view as pageView, type ServicesViewInputs } from "./view"

const NOW = Date.parse("2026-10-01T12:00:30Z")

const contextAt = (search: string): PageContext => ({
	env: { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false },
	location: { path: "/services", search },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
})
const context = contextAt("")
const inputs: ServicesViewInputs = {
	context,
	maybePresence: Option.some({ rows: [{ signal: "traces", status: "absent", lastSeenMs: null }], nowMs: NOW }),
	lastIngestAtMs: Option.none(),
}
const view = withViewInputs(pageView, inputs)()
/** Every Message the page's graph accepts: its own and its child Blocks' generated delivery. */
type PageMessage = typeof ServicesBlock.Message.Type
const pageUpdate = (model: Model, message: PageMessage) => update(model, message, context)

const entry = (serviceName: string): ServiceCatalogEntry => ({
	serviceName,
	serviceNamespaces: ["shop"],
	deploymentEnvironments: ["production"],
	spanCount: 100,
	errorCount: 2,
	errorRate: 0.02,
	p50LatencyMs: 10,
	p95LatencyMs: 20,
	p99LatencyMs: 30,
	logCount: 5,
})

/** Entered and anchored: the catalog request in flight. */
const anchored = () => pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW }))

const loaded = (catalog: ReadonlyArray<ServiceCatalogEntry>): Model => {
	const base = anchored().model
	return pageUpdate(base, Message.SucceededFetchCatalog({ key: base.catalog.key ?? "", catalog, fetchedAtMs: NOW })).model
}

describe("local services list", () => {
	test("entry reads the clock, then asks one catalog: unfiltered rows and facets are one key", () => {
		expect((init(context).commands ?? []).map(({ name }) => name)).toContain(ReadClock.name)
		const { commands } = anchored()
		expect((commands ?? []).map(({ name }) => name)).toEqual([FetchCatalog.name])
	})

	test("a filter adds the unfiltered catalog for the facets", () => {
		const filtered = contextAt("env=production")
		const result = update(init(filtered).model, Message.CompletedReadClock({ nowMs: NOW }), filtered)
		expect((result.commands ?? []).map(({ name }) => name)).toEqual([FetchCatalog.name, FetchCatalog.name])
		expect(result.model.catalog.key).not.toBe(result.model.unfiltered.key)
	})

	test("an answer for a superseded key is dropped", () => {
		const base = anchored().model
		const stale = pageUpdate(base, Message.SucceededFetchCatalog({ key: "stale", catalog: [entry("x")], fetchedAtMs: NOW }))
		expect(stale.model.catalog).toEqual(base.catalog)
	})

	test("rows render and a facet click filters the hash", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([entry("checkout-api"), entry("cart-svc")])),
			expectView(text("checkout-api")).toExist(),
			click(role("checkbox", { name: "production" })),
			expectOutMessage(PageOutMessage.RequestedNavigation({ hash: "#/services?env=production", isReplace: true })),
		)
	})

	test("an empty catalog asks for signal presence and renders the on-ramp", () => {
		const base = anchored().model
		const result = pageUpdate(base, Message.SucceededFetchCatalog({ key: base.catalog.key ?? "", catalog: [], fetchedAtMs: NOW }))
		expect(result.outMessage).toEqual(PageOutMessage.RequestedSignalPresence())
		scene({ update: pageUpdate, view }, given(result.model), expectView(text("No services yet")).toExist())
	})
})
