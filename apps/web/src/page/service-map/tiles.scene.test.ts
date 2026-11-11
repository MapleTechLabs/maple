import { OrgId } from "@maple/domain"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { Message as ResizableMessage, MountResizeGroup } from "@maple/views/ui/resizable"
import * as Tabs from "@maple/views/ui/tabs"
import { Array as Arr, Option, Order, Record as Rec, Result, Schema } from "effect"
import { click, expect as expectView, given, Mount, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import { Message } from "./message"
import { MapBundle, type Model } from "./model"
import * as Scene3d from "./scene3d"
import * as Tiles from "./tiles/update"
import { contextChanged, init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const facetsWindow = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const STORED = { prefs: { minTrafficPct: 0, collapsedNamespaces: [] }, snapshots: [] }
const CLOCK = { hour: 10.5, day: 80, isSouthern: false }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

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

const edge = (sourceService: string, targetService: string): Bundle["edges"][number] => ({
	sourceService,
	targetService,
	callCount: 120,
	estimatedCallCount: 120,
	errorCount: 0,
	errorRate: 0,
	avgDurationMs: 12,
	maxDurationMs: 40,
	hasSampling: false,
	samplingWeight: 1,
})

const bundle = (services: ReadonlyArray<string>, edges: Bundle["edges"]): Bundle => ({
	edges,
	dbEdges: [],
	dbEdgesTimedOut: false,
	overview: Arr.map(services, overview),
	platforms: [],
	workloads: [],
	runtimes: [],
})

const fetched = (model: Model, value: Bundle): Message =>
	Message.CompletedFetchBundle({
		key: model.bundle.key ?? "",
		result: Result.succeed(new MapBundle(value)),
	})

const run = (model: Model, messages: ReadonlyArray<(model: Model) => Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message(current)).model)

/** `/service-map?view=tiles` entered, windowed, with the prefs and a two-service bundle in. */
const loaded = (): Model =>
	run(init({ search: { view: "tiles" } }, context).model, [
		() =>
			Message.CompletedResolveWindow({ window, timeZone: "UTC", facetsWindow, nowMs: 0, mode: "Load" }),
		() => Message.CompletedReadStored({ stored: STORED }),
		(model) => fetched(model, bundle(["checkout", "payments"], [edge("checkout", "payments")])),
	])

const tiles = (message: Tiles.Message) => () => Message.GotTilesMessage({ message })
const selectedOf = (model: Model) => Option.flatMap(model.map, (map) => map.selectedId)

describe("service map tiles", () => {
	test("the board is laid out for the live map as soon as the map is in", () => {
		const model = loaded()
		expect(Arr.sort(Rec.keys(model.tiles.cells), Order.String)).toEqual(["checkout", "payments"])
	})

	test("a picked tile becomes the map's selection, and a miss clears it", () => {
		const picked = run(loaded(), [tiles(Tiles.Message.PickedNode({ nodeId: "payments" }))])
		expect(selectedOf(picked)).toEqual(Option.some("payments"))
		const cleared = run(picked, [tiles(Tiles.Message.PickedNode({ nodeId: null }))])
		expect(selectedOf(cleared)).toEqual(Option.none())
	})

	test("a service that joins the map gets a tile on the refresh, the rest keep theirs", () => {
		const before = loaded()
		const after = run(before, [
			() => Message.ClickedReload(),
			(model) =>
				fetched(
					model,
					bundle(
						["checkout", "payments", "ledger"],
						[edge("checkout", "payments"), edge("payments", "ledger")],
					),
				),
		])
		expect(after.tiles.cells["checkout"]).toEqual(before.tiles.cells["checkout"])
		expect(after.tiles.cells["payments"]).toEqual(before.tiles.cells["payments"])
		expect(after.tiles.cells["ledger"]).toBeDefined()
	})

	test("pinning a namespace lays the board out for the services left on the map", () => {
		const pinned = contextChanged(loaded(), { ...context, pinnedNamespace: "billing" }).model
		const onMap = Option.match(pinned.map, {
			onNone: () => [],
			onSome: (map) => Arr.map(map.graph.nodes, (node) => node.id),
		})
		expect(onMap).not.toContain("checkout")
		expect(Arr.sort(Rec.keys(pinned.tiles.cells), Order.String)).toEqual(Arr.sort(onMap, Order.String))
	})

	test("the landscape replaces the canvas, and a name plate opens the service panel", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			Mount.resolve({ name: MountResizeGroup.name }, ResizableMessage.EndedDrag()),
			Mount.resolve({ name: Scene3d.WatchTheme.name }, Tiles.Message.ResolvedTheme({ isDark: false })),
			Mount.resolve({ name: Tiles.WatchClock.name }, Tiles.Message.TickedClock({ clock: CLOCK })),
			Mount.resolve({ name: Tiles.MountScene.name }, Tiles.Message.HoveredCell({ cell: null })),
			expectView(role("region", { name: "Service map landscape" })).toExist(),
			expectView(role("button", { name: "payments" })).toHaveAttr("aria-pressed", "false"),
			click(role("button", { name: "payments" })),
			Mount.resolve(
				Tabs.MeasureTabIndicator,
				Tabs.Message.MeasuredIndicator({
					rect: { left: 0, right: 100, top: 0, bottom: 1, width: 100, height: 1 },
				}),
			),
			expectView(role("button", { name: "payments" })).toHaveAttr("aria-pressed", "true"),
		)
	})
})
