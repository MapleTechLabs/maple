import { DashboardId, OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Effect, Option, Result, Schema } from "effect"
import { beforeAll, describe, expect, test } from "vitest"
import { AppRoute } from "../route"
import type { PageContext } from "./contract"
import { Message } from "./dashboards/view/message"
import { enterRoute, PageMessage, type PageSlot, updatePage, loadEveryPage } from "./registry"

// Pages enter only once their code is loaded (`loadPageCode`); these tests drive loaded pages.
beforeAll(() => Effect.runPromise(loadEveryPage))

const orgId = Schema.decodeSync(OrgId)("org_acme")
const otherOrgId = Schema.decodeSync(OrgId)("org_other")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const documentOf = (id: string) =>
	Schema.decodeUnknownSync(DashboardDocument)({
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
	[
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(documentOf(id)) }),
	]
		.map((message) => stamp(id, instance, message))
		.reduce(
			(slot, message) => send(slot, message).slot,
			enterRoute(current, routeOf(id, true), context, instance).slot,
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
		expect([undo.orgId, undo.dashboardId, undo.widgets.map((widget) => widget.id)]).toEqual([
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
})
