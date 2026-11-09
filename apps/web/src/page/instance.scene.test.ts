import { DashboardId, OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { given, Mount, scene, type SceneSimulation, tap } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { AppRoute } from "../route"
import type { PageContext } from "./contract"
import { Message } from "./dashboards/view/message"
import { MeasureGrid } from "./dashboards/view/command"
import { enterRoute, PageMessage, type PageSlot, updatePage, viewPage } from "./registry"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const otherOrgId = Schema.decodeSync(OrgId)("org_other")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const documentOf = (id: string) =>
	Schema.decodeSync(DashboardDocument)({
		id,
		name: id,
		timeRange: { type: "relative", value: "6h" },
		widgets: [
			{
				id: "total-errors",
				visualization: "stat",
				dataSource: { kind: "route", endpoint: "errors_summary" },
				display: { title: "Errors", unit: "number" },
				layout: { x: 0, y: 0, w: 3, h: 2 },
			},
		],
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	})

const routeOf = (id: string, isEdit: boolean) =>
	AppRoute.Dashboard({
		dashboardId: Schema.decodeSync(DashboardId)(id),
		search: isEdit ? { mode: "edit" } : {},
	})

const stamp = (key: string, instance: number, message: Message, org: string = orgId): PageMessage => ({
	_tag: "DashboardView",
	key,
	orgId: org,
	instance,
	message,
})

const send = (slot: PageSlot | null, message: PageMessage) => updatePage(slot, message, context)

/** Dashboard `id` entered in edit mode as build `instance`, clocked and holding its document. */
const opened = (current: PageSlot | null, id: string, instance: number): PageSlot | null =>
	Arr.reduce(
		Arr.map(
			[
				Message.CompletedReadClock({ nowMs: NOW }),
				Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(documentOf(id)) }),
			],
			(message) => stamp(id, instance, message),
		),
		enterRoute(current, routeOf(id, true), context, instance).slot,
		(slot, message) => send(slot, message).slot,
	)

const deleteTile = (slot: PageSlot | null, id: string, instance: number) =>
	send(
		slot,
		stamp(
			id,
			instance,
			Message.GotWidgetMenuMessage({
				widgetId: "total-errors",
				message: { _tag: "ClickedItem", index: 3, item: { kind: "Item", value: "delete" } },
			}),
		),
	)

/** The toast's Undo: a root action, so the page that raised it need not be open. */
const undoOf = (step: ReturnType<typeof deleteTile>) =>
	Option.flatMap(step.outMessage, (out) =>
		out._tag === "RequestedToast" && out.rootAction?.action._tag === "RestoreDashboardWidgets"
			? Option.some(out.rootAction.action)
			: Option.none(),
	)

describe("page instances", () => {
	test("Undo on dashboard A's toast names A, so after B opened it restores into A, never B", () => {
		const onA = opened(null, "dash_a", 1)
		const undo = Option.getOrThrow(undoOf(deleteTile(onA, "dash_a", 1)))
		const onB = opened(onA, "dash_b", 2)
		expect(onB?.key).toBe("dash_b")
		expect([undo.orgId, undo.dashboardId, Arr.map(undo.widgets, (widget) => widget.id)]).toEqual([
			orgId,
			"dash_a",
			["total-errors"],
		])
	})

	test("dashboard A's late failed write does not make B read-only", () => {
		const onB = opened(opened(null, "dash_a", 1), "dash_b", 2)
		const late = send(
			onB,
			stamp("dash_a", 1, Message.CompletedWrite({ result: Result.fail("Write failed") })),
		)
		expect(late.slot?._tag === "DashboardView" ? late.slot.model.persistenceError : "missing").toBeNull()
	})

	test("a Message stamped for another org's instance of the same dashboard is dropped", () => {
		const onA = opened(null, "dash_a", 1)
		const late = send(
			onA,
			stamp("dash_a", 1, Message.CompletedWrite({ result: Result.fail("Write failed") }), otherOrgId),
		)
		expect(late.slot).toBe(onA)
	})

	test("A -> B -> A: a late answer from the first visit is dropped by the second", () => {
		const backOnA = opened(opened(opened(null, "dash_a", 1), "dash_b", 2), "dash_a", 3)
		const failed = Message.CompletedWrite({ result: Result.fail("Write failed") })
		expect(send(backOnA, stamp("dash_a", 1, failed)).slot).toBe(backOnA)
		const current = send(backOnA, stamp("dash_a", 3, failed)).slot
		expect(current?._tag === "DashboardView" ? current.model.persistenceError : null).not.toBeNull()
	})

	test("dashboard A -> B (a pinned link) mounts B's canvas afresh, so its width is measured", () => {
		const onA = opened(null, "dash_a", 1)
		const onB = opened(onA, "dash_b", 2)
		const htmlA = rendered(onA)
		expect(isPatchedInPlace(htmlA, rendered(onB), MeasureGrid.name)).toBe(false)
		// One instance re-rendering keeps its DOM.
		expect(isPatchedInPlace(htmlA, rendered(opened(onA, "dash_a", 1)), MeasureGrid.name)).toBe(true)
	})
})

type Node = Readonly<{
	sel?: string
	key?: PropertyKey
	data?: Readonly<Record<string, unknown>>
	children?: ReadonlyArray<Node | string>
}>

const isMountNode = (node: Node, name: string) => {
	const marker = node.data?.["foldkitMount"]
	return typeof marker === "object" && marker !== null && "name" in marker && marker.name === name
}

/** Child indices from `root` down to the first node carrying Mount `name`. */
const pathTo = (root: Node, name: string): ReadonlyArray<number> | null => {
	if (isMountNode(root, name)) return []
	const children = root.children ?? []
	for (const [index, child] of children.entries()) {
		if (typeof child === "string") continue
		const below = pathTo(child, name)
		if (below !== null) return [index, ...below]
	}
	return null
}

/** snabbdom's `sameVnode` all the way down: `next`'s Mount node reuses `previous`'s element, so it never re-mounts. */
const isPatchedInPlace = (previous: Node, next: Node, name: string): boolean => {
	const path = pathTo(next, name)
	if (path === null) throw new Error(`no ${name} mount in the rendered page`)
	const walk = (
		a: Node | string | undefined,
		b: Node | string | undefined,
		rest: ReadonlyArray<number>,
	): boolean => {
		if (a === undefined || b === undefined || typeof a === "string" || typeof b === "string") return false
		if (a.sel !== b.sel || a.key !== b.key) return false
		const [index, ...tail] = rest
		return index === undefined ? true : walk(a.children?.[index], b.children?.[index], tail)
	}
	return walk(previous, next, path)
}

const inputs = { context, isMobile: false, isBelowSm: false, isBelowLg: false }

/** The page as the root embeds it; every Mount resolved with a Message the no-op update ignores. */
const rendered = (slot: PageSlot | null): Node => {
	if (slot === null) throw new Error("no page entered")
	let html: Node = {}
	scene(
		{
			update: (model: PageSlot) => ({ model }),
			view: (model: PageSlot, h: HtmlBuilder<PageMessage>) =>
				viewPage(h, model, inputs, (message) => message),
		},
		given(slot),
		tap((simulation) => {
			html = simulation.html
		}),
		(simulation: SceneSimulation<PageSlot, PageMessage>) =>
			Arr.reduce(simulation.mounts, simulation, (current, mount) =>
				Mount.resolve(mount, null)(current),
			),
	)
	return html
}
