import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import { FetchWidget } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { slotOf } from "./plan"
import { subscriptions } from "./subscription"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => pageUpdate(current, message).model, model)

const stat = (id: string, endpoint: string, target?: { sectionId: string; tabId: string }) => ({
	id,
	visualization: "stat",
	dataSource: {
		kind: "route",
		endpoint,
		transform: { reduceToValue: { field: "value", aggregate: "first" } },
	},
	display: { title: id, unit: "number" },
	layout: { x: 0, y: 0, w: 3, h: 2 },
	...target,
})

const board = (widgets: ReadonlyArray<unknown>, sections: ReadonlyArray<unknown> = []) =>
	Schema.decodeUnknownSync(DashboardDocument)({
		id: "dash_hist",
		name: "History",
		timeRange: { type: "relative", value: "6h" },
		refreshIntervalSeconds: 60,
		widgets,
		sections,
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	})

const live = board([stat("w", "errors_summary")])
// v2: `w` read another endpoint then, and `gone` was deleted since, inside a group.
const snapshot = board(
	[stat("w", "service_overview"), stat("gone", "errors_summary", { sectionId: "s1", tabId: "a" })],
	[{ id: "s1", title: "Old group", tabs: [{ id: "a", title: "Old group" }] }],
)

const version = {
	id: "0192a3b4-0000-7000-8000-000000000002",
	versionNumber: 2,
	changeKind: "widget_added" as const,
	changeSummary: null,
	isRestore: false,
	createdAt: "2026-09-29T12:00:00.000Z",
	createdBy: "user_ada",
}

const ROUTE = { dashboardId: "dash_hist", search: { mode: "edit" as const } }

const ready = (): Model =>
	run(init(ROUTE, context).model, [
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(live) }),
		Message.RevealedWidget({ widgetId: "w" }),
		Message.GotMoreMenuMessage({
			message: { _tag: "ClickedItem", index: 4, item: { kind: "Item", value: "history" } },
		}),
		Message.CompletedFetchVersions({ generation: 1, result: Result.succeed([version]) }),
	])

const keyOf = (model: Model, widgetId: string) => {
	const gate = slotOf(model, widgetId).gate
	return gate?._tag === "Request" ? gate.request.key : null
}

const previewed = () => {
	const opened = run(ready(), [Message.ClickedVersion({ versionId: version.id })])
	return pageUpdate(
		opened,
		Message.CompletedFetchSnapshot({ versionId: version.id, result: Result.succeed(snapshot) }),
	)
}

describe("previewing a version", () => {
	test("a snapshot's tiles plan the snapshot's own queries, not the live board's", () => {
		const liveKey = keyOf(ready(), "w")
		const loaded = previewed()
		expect(keyOf(loaded.model, "w")).not.toBe(liveKey)
		expect(loaded.commands?.map(({ name }) => name)).toContain(FetchWidget.name)
		const revealed = pageUpdate(loaded.model, Message.RevealedWidget({ widgetId: "gone" })).model
		expect(keyOf(revealed, "gone")).not.toBeNull()
		expect(keyOf(pageUpdate(revealed, Message.ClickedCancelPreview()).model, "w")).toBe(liveKey)
	})

	test("auto-refresh pauses while a version is previewed", () => {
		const seconds = (model: Model) =>
			subscriptions.autoRefresh.modelToDependencies({ model, context }).seconds
		const viewing = { ...ready(), search: {} }
		expect(seconds(viewing)).toBe(60)
		expect(seconds(run(viewing, [Message.ClickedVersion({ versionId: version.id })]))).toBe(0)
	})

	test("a preview's groups collapse locally and leave the URL alone", () => {
		const collapsed = pageUpdate(
			previewed().model,
			Message.ClickedSectionChevron({ sectionId: "s1", collapsed: true }),
		)
		expect(collapsed.outMessage).toBeUndefined()
		expect(collapsed.model.history.sectionView).toEqual({ collapsed: "s1" })
		expect(pageUpdate(collapsed.model, Message.ClickedCancelPreview()).model.history.sectionView).toEqual(
			{},
		)
	})

	test("view-state changes keep edit mode in the URL while writes are unavailable", () => {
		const failed = pageUpdate(
			run(init(ROUTE, context).model, [
				Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(live) }),
			]),
			Message.CompletedWrite({ result: Result.fail("Write failed") }),
		).model
		expect(
			pageUpdate(failed, Message.ClickedSectionChevron({ sectionId: "s1", collapsed: true }))
				.outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/dashboards/dash_hist?mode=edit&collapsed=s1",
				isReplace: true,
			}),
		)
	})
})
