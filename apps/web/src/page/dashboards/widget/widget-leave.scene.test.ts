import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { AppRoute } from "../../../route"
import { PageOutMessage, type PageContext } from "../../contract"
import { blockNavigation, type PageSlot } from "../../registry"
import { SaveWidget } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./page-update"
import { init } from "./update"

// `useBlocker`: a link, Back or the breadcrumb away from unsaved edits asks first.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => update(current, message, context).model, model)

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_leave",
	name: "Leave",
	timeRange: { type: "relative", value: "6h" },
	widgets: [
		{
			id: "note",
			visualization: "markdown",
			dataSource: { kind: "static" },
			display: { title: "Note", markdown: { content: "hello" } },
			layout: { x: 0, y: 0, w: 3, h: 3 },
		},
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

const opened = () =>
	run(init({ dashboardId: "dash_leave", widgetId: "note", search: {} }, context).model, [
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
	])

const slotOf = (model: Model): PageSlot => ({
	_tag: "DashboardWidget",
	key: "dash_leave/note",
	orgId,
	instance: 1,
	model,
})
const away = AppRoute.Services({ search: {} })
const isHeld = (model: Model, route: AppRoute = away) =>
	Option.isSome(blockNavigation(slotOf(model), route, "/services", context))

describe("leaving the widget editor", () => {
	test("a navigation away from unsaved edits is held and asks", () => {
		const edited = run(opened(), [Message.ChangedTitle({ value: "Renamed" })])
		expect(isHeld(opened())).toBe(false)
		expect(isHeld(edited)).toBe(true)
		const held = Option.getOrThrow(blockNavigation(slotOf(edited), away, "/services", context))
		const model = held.slot?.model
		expect(model !== undefined && "leaveDialog" in model && model.leaveDialog.isOpen).toBe(true)
	})

	test("Discard goes where the held navigation was going", () => {
		const edited = run(opened(), [Message.ChangedTitle({ value: "Renamed" })])
		const asked = update(edited, Message.ClickedCancel(), context).model
		const held = { ...asked, pendingLeaveUrl: "/services" }
		expect(update(held, Message.ClickedDiscard(), context).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/services", isReplace: false }),
		)
	})

	test("after a save the way back is not held", () => {
		const edited = run(opened(), [Message.ChangedTitle({ value: "Renamed" })])
		const applying = update(edited, Message.ClickedApply(), context)
		expect((applying.commands ?? []).map(({ name }) => name)).toContain(SaveWidget.name)
		expect(isHeld(applying.model)).toBe(false)
		const saved = update(applying.model, Message.CompletedSave({ error: null }), context).model
		expect(isHeld(saved)).toBe(false)
	})
})
