import { DashboardId, OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { AppRoute } from "../route"
import type { PageContext } from "./contract"
import { Message } from "./dashboards/view/message"
import { enterRoute, PageMessage, type PageSlot, updatePage } from "./registry"

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
	AppRoute.Dashboard({ dashboardId: Schema.decodeSync(DashboardId)(id), search: isEdit ? { mode: "edit" } : {} })

const stamp = (key: string, message: Message, org: string = orgId): PageMessage => ({
	_tag: "DashboardView",
	key,
	orgId: org,
	message,
})

const isPageMessage = Schema.is(PageMessage)

const send = (slot: PageSlot | null, message: PageMessage) => updatePage(slot, message, context)

/** Dashboard `id` entered in edit mode, clocked and holding its document. */
const opened = (current: PageSlot | null, id: string): PageSlot | null =>
	[Message.CompletedReadClock({ nowMs: NOW }), Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(documentOf(id)) })]
		.map((message) => stamp(id, message))
		.reduce((slot, message) => send(slot, message).slot, enterRoute(current, routeOf(id, true), context).slot)

const deleteTile = (slot: PageSlot | null, id: string) =>
	send(
		slot,
		stamp(
			id,
			Message.GotWidgetMenuMessage({
				widgetId: "total-errors",
				message: { _tag: "ClickedItem", index: 3, item: { kind: "Item", value: "delete" } },
			}),
		),
	)

const undoOf = (step: ReturnType<typeof deleteTile>) =>
	Option.flatMap(step.outMessage, (out) =>
		out._tag === "RequestedToast" && out.action !== null && out.action !== undefined && isPageMessage(out.action.message)
			? Option.some(out.action.message)
			: Option.none(),
	)

const names = (step: { readonly commands: ReadonlyArray<{ readonly name: string }> }) =>
	step.commands.map(({ name }) => name)

describe("page instances", () => {
	test("Undo on dashboard A's toast, clicked after B opened, does not restore A's tile into B", () => {
		const onA = opened(null, "dash_a")
		const undo = Option.getOrThrow(undoOf(deleteTile(onA, "dash_a")))
		expect(names(send(onA, undo))).toEqual(["RestoreDashboardWidget"])
		const onB = opened(onA, "dash_b")
		expect(onB?.key).toBe("dash_b")
		const clicked = send(onB, undo)
		expect(clicked.commands).toEqual([])
		expect(clicked.slot).toBe(onB)
	})

	test("dashboard A's late failed write does not make B read-only", () => {
		const onB = opened(opened(null, "dash_a"), "dash_b")
		const late = send(onB, stamp("dash_a", Message.CompletedWrite({ result: Result.fail("Write failed") })))
		expect(late.slot?._tag === "DashboardView" ? late.slot.model.persistenceError : "missing").toBeNull()
	})

	test("a Message stamped for another org's instance of the same dashboard is dropped", () => {
		const onA = opened(null, "dash_a")
		const late = send(onA, stamp("dash_a", Message.CompletedWrite({ result: Result.fail("Write failed") }), otherOrgId))
		expect(late.slot).toBe(onA)
	})
})
