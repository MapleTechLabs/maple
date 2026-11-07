import { OrgId } from "@maple/domain"
import {
	ApplyWorldOpsResponse,
	IsoDateTimeString,
	serviceBuildingId,
	WorldConflictError,
	WorldDocument,
	WorldEntityRecord,
} from "@maple/domain/http"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { Option, Result, Schema, Array as Arr } from "effect"
import {
	click,
	Command,
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { Message as ResizableMessage, MountResizeGroup } from "@maple/views/ui/resizable"
import * as Tabs from "@maple/views/ui/tabs"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import type { PageContext } from "../contract"
import { SaveWorld } from "./command"
import { Applied, Conflicted, MoveBuilding, Rejected } from "./factory/edits"
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
	runtimes: [],
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
	return Arr.reduce(steps, entered, (model, step) => pageUpdate(model, step(model)).model)
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

const world = (entities: ReadonlyArray<WorldEntityRecord>) =>
	new WorldDocument({ schemaVersion: 1, entities })

const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

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
		const model = run(loaded(), [
			scene3d(Scene3d.Message.ResolvedTheme({ isDark: false })),
			scene3d(Scene3d.Message.LoadedWorld({ result: Result.succeed(world([])) })),
		])
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

const AT = Schema.decodeSync(IsoDateTimeString)("2026-11-07T12:00:00.000Z")

const payments = (building: "tank" | null, revision: number) =>
	new WorldEntityRecord({
		id: serviceBuildingId("payments"),
		entity: { _tag: "ServiceBuilding", nodeId: "payments", cell: { x: 6, z: 0 }, rotation: 0, building },
		revision,
		updatedAt: AT,
		updatedBy: null,
	})

const moveCheckout = (x: number) =>
	scene3d(
		Scene3d.Message.EditedWorld({
			command: MoveBuilding.make({ nodeId: "checkout", cell: { x, z: 9 } }),
		}),
	)

const commandNames = (model: Model, message: Message) =>
	Arr.map(pageUpdate(model, message).commands ?? [], (command) => command.name)

/** Theme resolved, the stored world answered, Customize pressed. */
const customizing = (entities: ReadonlyArray<WorldEntityRecord>) =>
	run(loaded(), [
		scene3d(Scene3d.Message.ResolvedTheme({ isDark: false })),
		scene3d(Scene3d.Message.LoadedWorld({ result: Result.succeed(world(entities)) })),
		scene3d(Scene3d.Message.ClickedCustomize()),
	])

describe("service map 3D: customize", () => {
	test("the viewport asks for the saved world once, and draws the canvas only once it is in", () => {
		const entered = loaded()
		expect(commandNames(entered, scene3d(Scene3d.Message.ResolvedTheme({ isDark: true })))).toEqual([
			"LoadServiceMapWorld",
		])
		const loading = run(entered, [scene3d(Scene3d.Message.ResolvedTheme({ isDark: true }))])
		expect(commandNames(loading, scene3d(Scene3d.Message.ResolvedTheme({ isDark: false })))).toEqual([])
	})

	test("a failed load keeps the automatic map and Customize off", () => {
		const model = run(loaded(), [
			scene3d(Scene3d.Message.ResolvedTheme({ isDark: false })),
			scene3d(Scene3d.Message.LoadedWorld({ result: Result.fail(toLoadFailure("down")) })),
			scene3d(Scene3d.Message.ClickedCustomize()),
		])
		expect(model.scene3d.worldState).toBe("failed")
		expect(model.scene3d.isEditing).toBe(false)
	})

	test("Customize switches Cascade back to Atlas; leaving Atlas ends it", () => {
		const cascade = run(loaded(), [
			clickPerspective("cascade", 1),
			scene3d(Scene3d.Message.ResolvedTheme({ isDark: false })),
			scene3d(Scene3d.Message.LoadedWorld({ result: Result.succeed(world([])) })),
			scene3d(Scene3d.Message.ClickedCustomize()),
		])
		expect(cascade.scene3d.perspective).toBe("atlas")
		expect(cascade.scene3d.isEditing).toBe(true)
		expect(run(cascade, [clickPerspective("cascade", 1)]).scene3d.isEditing).toBe(false)
	})

	test("one batch is in flight at a time; edits made meanwhile go out after it lands", () => {
		const model = customizing([])
		expect(commandNames(model, moveCheckout(12))).toEqual(["SaveServiceMapWorld"])
		const saving = run(model, [moveCheckout(12)])
		expect(saving.scene3d.isSaving).toBe(true)
		expect(commandNames(saving, moveCheckout(18))).toEqual([])
		const queued = run(saving, [moveCheckout(18)])
		const stored = new WorldEntityRecord({
			id: serviceBuildingId("checkout"),
			entity: {
				_tag: "ServiceBuilding",
				nodeId: "checkout",
				cell: { x: 12, z: 9 },
				rotation: 0,
				building: null,
			},
			revision: 1,
			updatedAt: AT,
			updatedBy: null,
		})
		const landed = scene3d(
			Scene3d.Message.SettledWorldOps({
				batch: 1,
				result: Result.succeed(
					Applied.make({ response: new ApplyWorldOpsResponse({ put: [stored], removed: [] }) }),
				),
			}),
		)
		expect(commandNames(queued, landed)).toEqual(["SaveServiceMapWorld"])
	})

	test("a trip to 2D and back keeps unsent edits, and the batch in flight still lands", () => {
		const saving = run(customizing([]), [moveCheckout(12), moveCheckout(18)])
		const flat = routeChanged(saving, { search: { view: "2d" } }, context).model
		const back = routeChanged(flat, { search: { view: "3d" } }, context).model
		expect(back.scene3d.isEditing).toBe(false)
		expect(back.scene3d.world).toBe(saving.scene3d.world)
		const stored = new WorldEntityRecord({
			id: serviceBuildingId("checkout"),
			entity: {
				_tag: "ServiceBuilding",
				nodeId: "checkout",
				cell: { x: 12, z: 9 },
				rotation: 0,
				building: null,
			},
			revision: 1,
			updatedAt: AT,
			updatedBy: null,
		})
		const landed = Message.CompletedSaveWorld({
			orgId,
			batch: 1,
			result: Result.succeed(
				Applied.make({ response: new ApplyWorldOpsResponse({ put: [stored], removed: [] }) }),
			),
		})
		// The queued move to x 18 goes out next, against the stored revision.
		expect(commandNames(back, landed)).toEqual(["SaveServiceMapWorld"])
	})

	test("an answer for another org or an older batch changes nothing", () => {
		const saving = run(customizing([]), [moveCheckout(12)])
		const otherOrg = Message.CompletedSaveWorld({
			orgId: "org_other",
			batch: 1,
			result: Result.fail(toLoadFailure("x")),
		})
		expect(pageUpdate(saving, otherOrg).model).toEqual(saving)
		const older = Message.CompletedSaveWorld({ orgId, batch: 0, result: Result.fail(toLoadFailure("x")) })
		expect(pageUpdate(saving, older).model.scene3d.isSaving).toBe(true)
		const otherLoad = Message.CompletedLoadWorld({
			orgId: "org_other",
			result: Result.succeed(world([])),
		})
		expect(pageUpdate(saving, otherLoad).model).toEqual(saving)
	})

	test("a batch the server refuses for good is undone and says so, and saving carries on", () => {
		const saving = run(customizing([]), [moveCheckout(12)])
		const refused = run(saving, [
			Message.CompletedSaveWorld({
				orgId,
				batch: 1,
				result: Result.succeed(Rejected.make({ message: "A world holds at most 5000 entities." })),
			}),
		])
		expect(refused.scene3d.world.value.local.size).toBe(0)
		expect(refused.scene3d.rejection).toBe("A world holds at most 5000 entities.")
		expect(refused.scene3d.isSaving).toBe(false)
		expect(commandNames(refused, moveCheckout(3))).toEqual(["SaveServiceMapWorld"])
	})

	test("a late load answer never replaces a world already being edited", () => {
		const editing = run(customizing([]), [moveCheckout(12)])
		const late = run(editing, [
			Message.CompletedLoadWorld({ orgId, result: Result.succeed(world([payments("tank", 9)])) }),
		])
		expect(late.scene3d.world).toBe(editing.scene3d.world)
	})

	test("back in 3D with nothing unsaved, the world is fetched again for teammates' changes", () => {
		const settled = customizing([payments("tank", 3)])
		const flat = routeChanged(settled, { search: { view: "2d" } }, context).model
		const back = routeChanged(flat, { search: { view: "3d" } }, context).model
		expect(back.scene3d.worldState).toBe("idle")
		expect(commandNames(back, scene3d(Scene3d.Message.ResolvedTheme({ isDark: true })))).toEqual([
			"LoadServiceMapWorld",
		])
	})

	test("losing a conflict says a teammate's change is on screen, until the next edit", () => {
		const saving = run(customizing([]), [moveCheckout(12)])
		const theirs = new WorldEntityRecord({
			id: serviceBuildingId("checkout"),
			entity: {
				_tag: "ServiceBuilding",
				nodeId: "checkout",
				cell: { x: 30, z: 0 },
				rotation: 0,
				building: "shed",
			},
			revision: 2,
			updatedAt: AT,
			updatedBy: null,
		})
		const lost = run(saving, [
			Message.CompletedSaveWorld({
				orgId,
				batch: 1,
				result: Result.succeed(
					Conflicted.make({
						conflict: new WorldConflictError({
							message: "changed",
							ids: [theirs.id],
							current: [theirs],
						}),
					}),
				),
			}),
		])
		expect(lost.scene3d.isConflicted).toBe(true)
		expect(lost.scene3d.world.value.local.get(theirs.id)).toEqual(theirs.entity)
		expect(run(lost, [moveCheckout(3)]).scene3d.isConflicted).toBe(false)
	})

	test("a failed load offers a retry", () => {
		const failed = run(loaded(), [
			scene3d(Scene3d.Message.ResolvedTheme({ isDark: false })),
			scene3d(Scene3d.Message.LoadedWorld({ result: Result.fail(toLoadFailure("down")) })),
		])
		expect(commandNames(failed, scene3d(Scene3d.Message.ClickedRetryLoad()))).toEqual([
			"LoadServiceMapWorld",
		])
	})

	test("a failed save keeps the edit on screen until Retry", () => {
		const saving = run(customizing([]), [moveCheckout(12)])
		const failed = run(saving, [
			scene3d(
				Scene3d.Message.SettledWorldOps({ batch: 1, result: Result.fail(toLoadFailure("offline")) }),
			),
		])
		expect(failed.scene3d.isSaveFailed).toBe(true)
		expect(failed.scene3d.world.value.local.size).toBe(1)
		expect(commandNames(failed, scene3d(Scene3d.Message.ClickedRetrySave()))).toEqual([
			"SaveServiceMapWorld",
		])
	})

	test("the panel shows the stored building type and picking Automatic undoes the override", () => {
		scene(
			{ update: pageUpdate, view },
			given(customizing([payments("tank", 3)])),
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
			expectView(text("Drag a building to move it. Click one to change what it looks like.")).toExist(),
			click(role("button", { name: "Select payments" })),
			measureTabs,
			expectView(role("button", { name: "Storage tank" })).toHaveAttr("aria-pressed", "true"),
			expectView(role("button", { name: "Undo" })).toHaveAttr("disabled", "true"),
			click(role("button", { name: "Automatic (Processor)" })),
			expectView(role("button", { name: "Automatic (Processor)" })).toHaveAttr("aria-pressed", "true"),
			expectView(text("Saving…")).toExist(),
			Command.resolve(
				SaveWorld,
				Message.CompletedSaveWorld({
					orgId,
					batch: 1,
					result: Result.succeed(
						Applied.make({
							response: new ApplyWorldOpsResponse({ put: [payments(null, 4)], removed: [] }),
						}),
					),
				}),
			),
			expectView(text("Saved for your org")).toExist(),
			click(role("button", { name: "Undo" })),
			expectView(role("button", { name: "Storage tank" })).toHaveAttr("aria-pressed", "true"),
			Command.resolve(
				SaveWorld,
				Message.CompletedSaveWorld({ orgId, batch: 2, result: Result.fail(toLoadFailure("x")) }),
			),
			expectView(text("Not saved")).toExist(),
		)
	})
})
