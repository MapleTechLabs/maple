import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import { applySectionEdit, SectionEdit } from "./section-edit"
import { EditSections, FetchWidget } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const stat = (id: string, target?: { sectionId: string; tabId: string }) => ({
	id,
	visualization: "stat",
	dataSource: {
		kind: "route",
		endpoint: "errors_summary",
		transform: { reduceToValue: { field: id, aggregate: "first" } },
	},
	display: { title: id, unit: "number" },
	layout: { x: 0, y: 0, w: 3, h: 2 },
	...target,
})

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_grouped",
	name: "Grouped",
	timeRange: { type: "relative", value: "6h" },
	widgets: [
		stat("root"),
		stat("in-a", { sectionId: "s1", tabId: "a" }),
		stat("in-b", { sectionId: "s1", tabId: "b" }),
	],
	sections: [
		{
			id: "s1",
			title: "Latency",
			tabs: [
				{ id: "a", title: "Overview" },
				{ id: "b", title: "Breakdown" },
			],
		},
		{ id: "s2", title: "Errors", tabs: [{ id: "c", title: "Errors" }] },
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

const ROUTE = { dashboardId: "dash_grouped", search: { mode: "edit" as const } }

const ready = (): Model =>
	[
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
	].reduce((model, message) => pageUpdate(model, message).model, init(ROUTE, context).model)

const nowIso = document.updatedAt

describe("dashboard groups", () => {
	test("a chevron collapses the group for this viewer only, in the URL", () => {
		expect(
			pageUpdate(ready(), Message.ClickedSectionChevron({ sectionId: "s1", collapsed: true }))
				.outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/dashboards/dash_grouped?mode=edit&collapsed=s1",
				isReplace: true,
			}),
		)
	})

	test("a tab click writes the active tab to the URL and nothing to the board", () => {
		const clicked = pageUpdate(ready(), Message.ClickedSectionTab({ sectionId: "s1", tabId: "b" }))
		expect(names(clicked.commands)).toEqual([])
		expect(clicked.outMessage?._tag).toBe("RequestedNavigation")
	})

	test("a rename commits once, trimmed; an unchanged or empty title writes nothing", () => {
		const started = pageUpdate(ready(), Message.StartedRename({ sectionId: "s1", tabId: null })).model
		expect(started.rename?.draft).toBe("Latency")
		const typed = pageUpdate(started, Message.ChangedRenameDraft({ value: "  SLOs " })).model
		expect(names(pageUpdate(typed, Message.SubmittedRename()).commands)).toEqual([EditSections.name])
		const blank = pageUpdate(started, Message.ChangedRenameDraft({ value: "  " })).model
		expect(names(pageUpdate(blank, Message.SubmittedRename()).commands)).toEqual([])
	})

	test("a group's own + opens the picker aimed at its tab, and closing it resets the aim", () => {
		const opened = pageUpdate(
			ready(),
			Message.ClickedAddSectionWidget({ sectionId: "s1", tabId: "a" }),
		).model
		expect(opened.pickerTarget).toEqual({ sectionId: "s1", tabId: "a" })
		expect(pageUpdate(opened, Message.ClickedAddWidget()).model.pickerTarget).toBeNull()
	})

	test("a stat's sparkline series is asked for only once the stat has its value", () => {
		const route = { dashboardId: "dash_grouped", search: {} }
		const model = routeChanged(ready(), route, context).model
		const revealed = pageUpdate(model, Message.RevealedWidget({ widgetId: "root" }))
		expect(names(revealed.commands)).toEqual([FetchWidget.name])
		expect(revealed.model.widgets.root?.sparkGate ?? null).toBeNull()
		const key = Object.keys(revealed.model.requests)[0] ?? ""
		const answered = pageUpdate(
			revealed.model,
			Message.CompletedFetchWidget({ key, result: Result.succeed({ data: [] }) }),
		)
		expect(answered.model.requests[key]).toBeDefined()
	})

	test("deleting a tab moves its widgets to the first remaining tab, below what it holds", () => {
		const next = applySectionEdit(
			SectionEdit.DeleteTab({ sectionId: "s1", tabId: "b", action: "move" }),
			document,
			nowIso,
			() => "unused",
		)
		expect(next.sections?.[0]?.tabs.map((tab) => tab.id)).toEqual(["a"])
		expect(next.sections?.[0]?.title).toBe("Overview")
		const moved = next.widgets.find((widget) => widget.id === "in-b")
		expect(moved?.tabId).toBe("a")
		expect(moved?.layout.y).toBe(2)
	})

	test("deleting a group can keep its widgets on the root canvas, below the root's", () => {
		const next = applySectionEdit(
			SectionEdit.DeleteSection({ sectionId: "s1", action: "ungroup" }),
			document,
			nowIso,
			() => "unused",
		)
		expect(next.sections?.map((section) => section.id)).toEqual(["s2"])
		expect(
			next.widgets.filter((widget) => widget.sectionId === undefined).map((w) => w.layout.y),
		).toEqual([0, 2, 2])
	})

	test("a new group mints its id, then its tab's", () => {
		const ids = ["g1", "t1"]
		const next = applySectionEdit(SectionEdit.AddSection(), document, nowIso, () => ids.shift() ?? "")
		expect(next.sections?.at(-1)).toEqual({
			id: "g1",
			title: "New group",
			tabs: [{ id: "t1", title: "New group" }],
		})
	})
})
