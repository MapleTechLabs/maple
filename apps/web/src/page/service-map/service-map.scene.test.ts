import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import {
	click,
	Command,
	expect as expectView,
	given,
	label,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../charts/theme-colors"
import { toLoadFailure } from "../../data/load-failure"
import * as ServiceMap from "../../service-map/map/service-map"
import { PageOutMessage, type PageContext } from "../contract"
import { CompleteReloadSpin, FetchBundle, FetchFacets, ResolveWindow } from "./command"
import { Message } from "./message"
import { MapBundle, type Model } from "./model"
import { ALL_ENVIRONMENTS, selectedEnvironment } from "./derive"
import { contextChanged, init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const facetsWindow = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const STORED = { prefs: { minTrafficPct: 0, collapsedNamespaces: [] }, snapshots: [] }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

type Bundle = MapBundle["value"]

const overview = (serviceName: string): Bundle["overview"][number] => ({
	serviceName,
	serviceNamespace: "",
	environment: "production",
	commits: [],
	p50LatencyMs: 10,
	p95LatencyMs: 20,
	p99LatencyMs: 30,
	errorRate: 0,
	throughput: 1,
	tracedThroughput: 1,
	hasSampling: false,
	samplingWeight: 1,
	spanCount: 100,
})

const BUNDLE: Bundle = {
	edges: [
		{
			sourceService: "checkout",
			targetService: "payments",
			callCount: 120,
			estimatedCallCount: 120,
			errorCount: 0,
			errorRate: 0,
			avgDurationMs: 12,
			maxDurationMs: 40,
			hasSampling: false,
			samplingWeight: 1,
		},
	],
	dbEdges: [
		{
			sourceService: "payments",
			dbSystem: "postgresql",
			dbNamespace: "shop",
			callCount: 300,
			estimatedCallCount: 300,
			errorCount: 0,
			errorRate: 0,
			avgDurationMs: 3,
			maxDurationMs: 9,
			p95DurationMs: 6,
			hasSampling: false,
			samplingWeight: 1,
		},
	],
	overview: [overview("checkout"), overview("payments")],
	platforms: [],
	workloads: [],
}

const EMPTY_BUNDLE: Bundle = { edges: [], dbEdges: [], overview: [], platforms: [], workloads: [] }

/** Entered, windowed and with the stored prefs read. */
const windowed = (search: Model["search"] = {}): Model => {
	const entered = init({ search }, context).model
	const resolved = pageUpdate(
		entered,
		Message.CompletedResolveWindow({ window, timeZone: "UTC", facetsWindow, nowMs: NOW, mode: "Load" }),
	).model
	return pageUpdate(resolved, Message.CompletedReadStored({ stored: STORED })).model
}

const withBundle = (model: Model, bundle: Bundle): Model =>
	pageUpdate(
		model,
		Message.CompletedFetchBundle({
			key: model.bundle.key ?? "",
			result: Result.succeed(new MapBundle(bundle)),
		}),
	).model

const mapOf = (model: Model) => Option.getOrThrow(model.map)

describe("service map page: requests", () => {
	test("entry resolves the windows and reads the stored prefs, then asks every query", () => {
		const entry = init({ search: {} }, context)
		expect(names(entry.commands)).toEqual(
			expect.arrayContaining(["ResolveServiceMapWindow", "ReadServiceMapStored"]),
		)
		const resolved = pageUpdate(
			entry.model,
			Message.CompletedResolveWindow({
				window,
				timeZone: "UTC",
				facetsWindow,
				nowMs: NOW,
				mode: "Load",
			}),
		)
		expect(names(resolved.commands)).toEqual(
			expect.arrayContaining([
				"FetchServiceMapFacets",
				"FetchServiceMapBundle",
				"FetchServiceMapCloudflare",
				"FetchServiceMapPlanetScale",
				"FetchPlanetScaleInventory",
				"FetchCloudflareHyperdrives",
			]),
		)
	})

	test("a zone change re-resolves the window in the new zone; a pin change does not", () => {
		const model = windowed({ timePreset: "today" })
		const rezoned = contextChanged(model, { ...context, timeZone: "Europe/Berlin" })
		expect(
			rezoned.commands?.find((command) => command.name === "ResolveServiceMapWindow")?.args,
		).toMatchObject({
			preset: "today",
			timeZone: "Europe/Berlin",
		})
		const pinned = contextChanged(model, { ...context, pinnedNamespace: "shop" })
		expect(names(pinned.commands)).not.toContain("ResolveServiceMapWindow")
	})

	test("before facets land the bundle is scoped to production; a no-production org widens it", () => {
		const model = windowed()
		const before = model.bundle.key
		const facets = pageUpdate(
			model,
			Message.CompletedFetchFacets({
				key: model.facets.key ?? "",
				result: Result.succeed(["staging"]),
			}),
		)
		expect(names(facets.commands)).toEqual(["FetchServiceMapBundle"])
		expect(facets.model.bundle.key).not.toBe(before)
		const confirmed = pageUpdate(
			model,
			Message.CompletedFetchFacets({
				key: model.facets.key ?? "",
				result: Result.succeed(["production"]),
			}),
		)
		expect(names(confirmed.commands)).toEqual([])
	})

	test("an answer for a superseded key is dropped", () => {
		const model = windowed()
		const stale = pageUpdate(
			model,
			Message.CompletedFetchBundle({ key: "stale", result: Result.succeed(new MapBundle(BUNDLE)) }),
		).model
		expect(stale.map).toEqual(Option.none())
		expect(Option.isSome(withBundle(model, BUNDLE).map)).toBe(true)
	})

	test("Reload revalidates the environment facets past the read cache, as legacy's refresh", () => {
		const windowedModel = windowed()
		const loaded = pageUpdate(
			windowedModel,
			Message.CompletedFetchFacets({
				key: windowedModel.facets.key ?? "",
				result: Result.succeed(["production"]),
			}),
		).model
		const empty = withBundle(loaded, EMPTY_BUNDLE)
		const refreshed = Message.CompletedResolveWindow({
			window,
			timeZone: "UTC",
			facetsWindow,
			nowMs: NOW,
			mode: "Refresh",
		})
		scene(
			{ update: pageUpdate, view },
			given(empty),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			click(role("button", { name: "Reload" })),
			Command.resolve(ResolveWindow, refreshed),
			Command.expectHas(
				FetchFacets({ key: empty.facets.key ?? "", window: facetsWindow, refresh: true }),
			),
			Command.resolveAll(
				[CompleteReloadSpin, Message.CompletedReloadSpin({ version: 1 })],
				[
					FetchFacets,
					Message.CompletedFetchFacets({
						key: empty.facets.key ?? "",
						result: Result.succeed(["production"]),
					}),
				],
				[
					FetchBundle,
					Message.CompletedFetchBundle({
						key: empty.bundle.key ?? "",
						result: Result.succeed(new MapBundle(EMPTY_BUNDLE)),
					}),
				],
			),
		)
		const entry = pageUpdate(
			windowedModel,
			Message.CompletedFetchFacets({ key: windowedModel.facets.key ?? "", result: Result.succeed([]) }),
		)
		const reentered = pageUpdate(
			entry.model,
			Message.CompletedResolveWindow({
				window,
				timeZone: "UTC",
				facetsWindow,
				nowMs: NOW,
				mode: "Load",
			}),
		)
		expect(names(reentered.commands)).not.toContain("FetchServiceMapFacets")
	})

	test("selecting a database node requests its query summary", () => {
		const model = withBundle(windowed(), BUNDLE)
		const selected = pageUpdate(
			model,
			Message.GotMapMessage({
				message: ServiceMap.Message.ClickedNode({ nodeId: "db:postgresql:shop" }),
			}),
		)
		expect(names(selected.commands)).toContain("FetchServiceDbQuerySummary")
	})
})

const urlOf = (result: { readonly outMessage?: PageOutMessage }) =>
	result.outMessage?._tag === "RequestedNavigation" ? result.outMessage : undefined

describe("service map page: navigation", () => {
	test("focusing a service from the map writes it to the URL, replacing the entry", () => {
		const model = withBundle(windowed(), BUNDLE)
		const focused = pageUpdate(
			model,
			Message.GotMapMessage({ message: ServiceMap.Message.ClickedNode({ nodeId: "payments" }) }),
		)
		const viaPanel = pageUpdate(
			focused.model,
			Message.GotMapMessage({ message: ServiceMap.Message.ClickedFocusSelected() }),
		)
		expect(urlOf(viaPanel)).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/service-map?focusService=payments",
				isReplace: true,
			}),
		)
	})

	test("the URL's focus reaches the map without navigating again", () => {
		const model = withBundle(windowed(), BUNDLE)
		const next = routeChanged(model, { search: { focusService: "payments", focusMode: "hide" } }, context)
		expect(Option.map(mapOf(next.model).focus, (focus) => focus.mode)).toEqual(Option.some("hide"))
		expect(next.outMessage).toBeUndefined()
	})

	test("after a Reload an environment change keeps the window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(withBundle(windowed(), BUNDLE), Message.ClickedReload()).model
		const scoped = routeChanged(reloaded, { search: { environment: "production" } }, context)
		expect(names(scoped.commands)).not.toContain("ResolveServiceMapWindow")
		expect(scoped.model.window).toEqual(reloaded.window)
		const moved = routeChanged(
			scoped.model,
			{ search: { environment: "production", timePreset: "1h" } },
			context,
		)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([
			["ResolveServiceMapWindow", "Refresh"],
		])
	})

	test("the view switch and the environment select navigate", () => {
		const model = windowed()
		expect(urlOf(pageUpdate(model, Message.ClickedView({ view: "3d" })))?.url).toBe(
			"/service-map?view=3d",
		)
	})
})

describe("service map page: view", () => {
	test("an empty window shows a skeleton until presence is known, then the setup canvas", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("LoadServiceMapSignalPresence")
		const empty = withBundle(windowed(), EMPTY_BUNDLE)
		scene(
			{ update: pageUpdate, view },
			given(empty),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			expectView(text("No service calls found")).not.toExist(),
			expectView(label("Loading")).toExist(),
		)
		const absent = pageUpdate(
			empty,
			Message.CompletedLoadSignalPresence({
				result: Result.succeed({ traces: { status: "absent", lastSeenMs: null } }),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(absent),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			expectView(text("No service calls yet")).toExist(),
		)
	})
})

describe("service map page: environment default across a refetch", () => {
	test("a refetch keeps a confirmed no-production org on all environments and the mount's facets window", () => {
		const model = windowed()
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchFacets({
				key: model.facets.key ?? "",
				result: Result.succeed(["staging"]),
			}),
		).model
		expect(selectedEnvironment(loaded)).toBe(ALL_ENVIRONMENTS)
		const later = { startTime: "2026-09-30 13:00:00", endTime: "2026-10-01 13:00:00" }
		const refreshed = pageUpdate(
			loaded,
			Message.CompletedResolveWindow({
				window,
				timeZone: "UTC",
				facetsWindow: later,
				nowMs: NOW,
				mode: "Refresh",
			}),
		)
		expect(selectedEnvironment(refreshed.model)).toBe(ALL_ENVIRONMENTS)
		expect(refreshed.model.facetsWindow).toEqual(facetsWindow)
		expect(refreshed.model.bundle.key).toBe(loaded.bundle.key)
	})

	test("a failed facets refetch keeps the environment the previous facets chose", () => {
		const model = windowed()
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchFacets({
				key: model.facets.key ?? "",
				result: Result.succeed(["staging"]),
			}),
		).model
		const refreshed = pageUpdate(
			loaded,
			Message.CompletedResolveWindow({
				window,
				timeZone: "UTC",
				facetsWindow,
				nowMs: NOW,
				mode: "Refresh",
			}),
		).model
		const failed = pageUpdate(
			refreshed,
			Message.CompletedFetchFacets({
				key: refreshed.facets.key ?? "",
				result: Result.fail(toLoadFailure(new Error("down"))),
			}),
		)
		expect(selectedEnvironment(failed.model)).toBe(ALL_ENVIRONMENTS)
		expect(names(failed.commands)).not.toContain("FetchServiceMapBundle")
	})
})
