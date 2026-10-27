import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import { click, expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../charts/theme-colors"
import { Message as ResizableMessage, MountResizeGroup } from "../../ui/resizable"
import * as Tabs from "../../ui/tabs"
import * as ToggleGroup from "../../ui/toggle-group"
import type { PageContext } from "../contract"
import { Message } from "./message"
import { MapBundle, type Model } from "./model"
import * as Scene3d from "./scene3d"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const facetsWindow = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const STORED = { prefs: { minTrafficPct: 0, collapsedNamespaces: [] }, snapshots: [] }

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
	dbEdges: [],
	dbEdgesTimedOut: false,
	overview: [overview("checkout"), overview("payments")],
	platforms: [],
	workloads: [],
}

/** `/service-map?view=3d` entered, windowed, with the prefs and the bundle in. */
const loaded = (): Model => {
	const entered = init({ search: { view: "3d" } }, context).model
	const steps: ReadonlyArray<(model: Model) => Message> = [
		() =>
			Message.CompletedResolveWindow({ window, timeZone: "UTC", facetsWindow, nowMs: 0, mode: "Load" }),
		() => Message.CompletedReadStored({ stored: STORED }),
		(model) =>
			Message.CompletedFetchBundle({
				key: model.bundle.key ?? "",
				result: Result.succeed(new MapBundle(BUNDLE)),
			}),
	]
	return steps.reduce((model, step) => pageUpdate(model, step(model)).model, entered)
}

const scene3d = (message: Scene3d.Message) => Message.GotScene3dMessage({ message })
const selectedOf = (model: Model) => Option.flatMap(model.map, (map) => map.selectedId)
const clickPerspective = (value: string, index: number) =>
	scene3d(
		Scene3d.Message.GotPerspectiveMessage({ message: ToggleGroup.Message.ClickedItem({ value, index }) }),
	)

/** The service panel's tab indicator, measured once the panel opens. */
const measureTabs = Mount.resolve(
	Tabs.MeasureTabIndicator,
	Tabs.Message.MeasuredIndicator({
		rect: { left: 0, right: 100, top: 0, bottom: 1, width: 100, height: 1 },
	}),
)

const run = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => pageUpdate(current, message).model, model)

describe("service map 3D: viewport state", () => {
	test("Cascade switches the perspective; pressing it again keeps it, as legacy ignores a release", () => {
		const cascade = run(loaded(), [clickPerspective("cascade", 1)])
		expect(cascade.scene3d.perspective).toBe("cascade")
		expect(cascade.scene3d.perspectiveGroup.values).toEqual(["cascade"])
		const again = run(cascade, [clickPerspective("cascade", 1)])
		expect(again.scene3d.perspective).toBe("cascade")
		expect(again.scene3d.perspectiveGroup.values).toEqual(["cascade"])
	})

	test("the traffic button toggles, and every camera click is a new command", () => {
		const model = run(loaded(), [
			scene3d(Scene3d.Message.ClickedTraffic({ isFlowing: true })),
			scene3d(Scene3d.Message.ClickedCamera({ action: "in" })),
			scene3d(Scene3d.Message.ClickedCamera({ action: "in" })),
		])
		expect(model.scene3d.traffic).toBe(false)
		expect(model.scene3d.command).toEqual({ action: "in", serial: 2 })
	})

	test("under reduced motion the paused traffic can still be turned on", () => {
		const model = run(loaded(), [scene3d(Scene3d.Message.ClickedTraffic({ isFlowing: false }))])
		expect(model.scene3d.traffic).toBe(true)
	})

	test("WebGL failing shows the fallback; the theme resolves the palette", () => {
		const model = run(loaded(), [
			scene3d(Scene3d.Message.ResolvedTheme({ isDark: false })),
			scene3d(Scene3d.Message.FailedScene()),
		])
		expect(model.scene3d.isDark).toBe(false)
		expect(model.scene3d.isFailed).toBe(true)
	})

	test("switching to 3D starts the viewport over; staying in 3D keeps it", () => {
		const cascade = run(loaded(), [clickPerspective("cascade", 1)])
		const kept = routeChanged(cascade, { search: { view: "3d", focusService: "payments" } }, context)
		expect(kept.model.scene3d.perspective).toBe("cascade")
		const flat = routeChanged(cascade, { search: { view: "2d" } }, context).model
		const back = routeChanged(flat, { search: { view: "3d" } }, context).model
		expect(back.scene3d).toEqual(Scene3d.init())
	})
})

describe("service map 3D: picking", () => {
	test("a picked machine or sign becomes the map's selection, and a miss clears it", () => {
		const picked = run(loaded(), [scene3d(Scene3d.Message.PickedNode({ nodeId: "payments" }))])
		expect(selectedOf(picked)).toEqual(Option.some("payments"))
		const cleared = run(picked, [scene3d(Scene3d.Message.PickedNode({ nodeId: null }))])
		expect(selectedOf(cleared)).toEqual(Option.none())
	})

	test("a belt tag selects its target even when another node is selected", () => {
		const model = run(loaded(), [
			scene3d(Scene3d.Message.PickedNode({ nodeId: "checkout" })),
			scene3d(Scene3d.Message.PickedNode({ nodeId: "payments" })),
		])
		expect(selectedOf(model)).toEqual(Option.some("payments"))
	})

	test("a sign toggles its node's selection; a selected node's belt tag picks the call's target", () => {
		const model = run(loaded(), [scene3d(Scene3d.Message.ResolvedTheme({ isDark: false }))])
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			Mount.resolve({ name: MountResizeGroup.name }, ResizableMessage.EndedDrag()),
			Mount.resolve(
				{ name: Scene3d.WatchTheme.name },
				scene3d(Scene3d.Message.ResolvedTheme({ isDark: false })),
			),
			Mount.resolve(
				{ name: Scene3d.MountScene.name },
				scene3d(Scene3d.Message.PickedNode({ nodeId: null })),
			),
			expectView(role("region", { name: "Atlas 3D service map" })).toExist(),
			expectView(role("button", { name: "Select payments" })).toHaveAttr("aria-pressed", "false"),
			click(role("button", { name: "Select payments" })),
			measureTabs,
			expectView(role("button", { name: "Select payments" })).toHaveAttr("aria-pressed", "true"),
			expectView(text("2 connected nodes · click the canvas to clear")).toExist(),
			click(role("button", { name: "Select payments" })),
			Mount.expectEnded(Tabs.MeasureTabIndicator),
			expectView(role("button", { name: "Select payments" })).toHaveAttr("aria-pressed", "false"),
			click(role("button", { name: "Select checkout" })),
			measureTabs,
			click(role("button", { name: /^Inspect connection to payments/ })),
			expectView(role("button", { name: "Select payments" })).toHaveAttr("aria-pressed", "true"),
		)
	})

	test("picking the selection again changes nothing", () => {
		const picked = run(loaded(), [scene3d(Scene3d.Message.PickedNode({ nodeId: "payments" }))])
		const again = pageUpdate(picked, scene3d(Scene3d.Message.PickedNode({ nodeId: "payments" })))
		expect(again.model.map).toEqual(picked.map)
	})
})
