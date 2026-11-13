import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Option, Result, Schema, Array as Arr } from "effect"
import { Mount, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { describe, expect, test } from "vitest"
import * as Menu from "@maple/views/ui/menu"
import type { PageContext } from "../../contract"
import { MeasureGrid, WatchGridHandles, WatchWidget } from "./command"
import { Message } from "./message"
import { isEditing } from "./mode"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// An observer reads a board; editing needs `dashboards:edit` and sharing `dashboards:share`.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const DASHBOARD_ID = "dash_platform"
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)
const view = withViewInputs(pageView, { context })()
const themed = () => Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
/** The canvas measured and its one tile in view. */
const mounted = () => [
	themed(),
	Mount.resolve(MeasureGrid, Message.MeasuredGrid({ width: 1200 })),
	Mount.resolve(WatchGridHandles, Message.BlurredGrip({ widgetId: "note" })),
	Mount.resolve(WatchWidget, Message.RevealedWidget({ widgetId: "note" })),
]

const note = {
	id: "note",
	visualization: "markdown",
	dataSource: { kind: "static" },
	display: { title: "Runbook", markdown: { content: "Page the platform on-call first." } },
	layout: { x: 0, y: 0, w: 6, h: 2 },
}

const board = (widgets: ReadonlyArray<unknown>) =>
	Schema.decodeUnknownSync(DashboardDocument)({
		id: DASHBOARD_ID,
		name: "Platform overview",
		timeRange: { type: "relative", value: "6h" },
		widgets,
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	})

const version = {
	id: "0192a3b4-0000-7000-8000-000000000002",
	versionNumber: 2,
	changeKind: "widget_added" as const,
	changeSummary: null,
	isRestore: false,
	createdAt: "2026-09-29T12:00:00.000Z",
	createdBy: "user_ada",
}

const MEMBER = Policy.grantsOf(["org:member"])
const OBSERVER = Policy.grantsOf(["org:observer"])
type Grants = ReadonlyArray<Policy.Permission>

/** Entered, clocked, holding the session's grants and the document. */
const ready = (grants: Grants, search: { mode?: "edit" } = {}, document = board([note])): Model =>
	run(init({ dashboardId: DASHBOARD_ID, search }, context).model, [
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.CompletedFetchSession({ orgId, grants }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
	])

const withMoreMenuOpen = (model: Model): Model => ({
	...model,
	moreMenu: Menu.init(model.moreMenu.id, { isOpen: true }),
})

/** History opened, then v2 previewed with its snapshot loaded. */
const previewV2 = (model: Model): Model =>
	run(model, [
		Message.GotMoreMenuMessage({
			message: { _tag: "ClickedItem", index: 0, item: { kind: "Item", value: "history" } },
		}),
		Message.CompletedFetchVersions({
			generation: model.history.versionsGeneration + 1,
			nowMs: 0,
			result: Result.succeed([version]),
		}),
		Message.ClickedVersion({ versionId: version.id }),
		Message.CompletedFetchSnapshot({ versionId: version.id, result: Result.succeed(board([note])) }),
	])

describe("a dashboard for an observer", () => {
	test("the board and its widgets render without an Edit control", () => {
		scene(
			{ update: pageUpdate, view },
			given(ready(OBSERVER)),
			...mounted(),
			expectView(text("Page the platform on-call first.")).toExist(),
			expectView(role("button", { name: "Reload" })).toExist(),
			expectView(role("button", { name: "Edit dashboard" })).toBeAbsent(),
		)
	})

	test("a member gets the Edit control", () => {
		scene(
			{ update: pageUpdate, view },
			given(ready(MEMBER)),
			...mounted(),
			expectView(role("button", { name: "Edit dashboard" })).toExist(),
		)
	})

	test("?mode=edit lands on the read view", () => {
		const model = ready(OBSERVER, { mode: "edit" })
		expect(isEditing(model)).toBe(false)
		scene(
			{ update: pageUpdate, view },
			given(model),
			...mounted(),
			expectView(text("Page the platform on-call first.")).toExist(),
			expectView(role("button", { name: "Done editing" })).toBeAbsent(),
			expectView(role("button", { name: "Add widget" })).toBeAbsent(),
			expectView(role("button", { name: "Widget actions" })).toBeAbsent(),
		)
	})

	test("?mode=edit edits for a member", () => {
		const model = ready(MEMBER, { mode: "edit" })
		expect(isEditing(model)).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(model),
			...mounted(),
			expectView(role("button", { name: "Done editing" })).toExist(),
			expectView(role("button", { name: "Add widget" })).toExist(),
		)
	})

	test("the name is a heading, not a rename control", () => {
		const model = ready(OBSERVER)
		expect(pageUpdate(model, Message.ClickedTitle()).model.titleDraft).toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(model),
			...mounted(),
			expectView(role("heading", { name: "Platform overview" })).toExist(),
			expectView(role("button", { name: "Platform overview" })).toBeAbsent(),
		)
	})

	test("a member renames from the name", () => {
		const model = ready(MEMBER)
		expect(pageUpdate(model, Message.ClickedTitle()).model.titleDraft).toBe("Platform overview")
		scene(
			{ update: pageUpdate, view },
			given(model),
			...mounted(),
			expectView(role("button", { name: "Platform overview" })).toExist(),
		)
	})

	test("the more menu keeps history and export and drops Share", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMoreMenuOpen(ready(OBSERVER))),
			...mounted(),
			Mount.resolve(Menu.MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(role("menuitem", { name: "Version history" })).toExist(),
			expectView(role("menuitem", { name: "Export as JSON" })).toExist(),
			expectView(role("menuitem", { name: "Share…" })).toBeAbsent(),
		)
	})

	test("a member's more menu shares", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMoreMenuOpen(ready(MEMBER))),
			...mounted(),
			Mount.resolve(Menu.MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(role("menuitem", { name: "Share…" })).toExist(),
		)
	})

	test("a previewed version can be left but not restored", () => {
		const previewed = previewV2(ready(OBSERVER))
		expect(previewed.history.previewed?.id).toBe(version.id)
		expect(pageUpdate(previewed, Message.ClickedRestoreVersion()).model.history.restoreDialog).toEqual(
			previewed.history.restoreDialog,
		)
		scene(
			{ update: pageUpdate, view },
			given(previewed),
			...mounted(),
			expectView(role("button", { name: "Cancel" })).toExist(),
			expectView(role("button", { name: /Restore this version/ })).toBeAbsent(),
		)
	})

	test("a member restores a previewed version", () => {
		scene(
			{ update: pageUpdate, view },
			given(previewV2(ready(MEMBER))),
			...mounted(),
			expectView(role("button", { name: /Restore this version/ })).toBeEnabled(),
		)
	})

	test("an empty board offers nothing to add", () => {
		scene(
			{ update: pageUpdate, view },
			given(ready(OBSERVER, {}, board([]))),
			themed(),
			expectView(text("Nothing on this board yet")).toExist(),
			expectView(role("button", { name: "Add your first widget" })).toBeAbsent(),
			expectView(role("link", { name: "Start from a template" })).toBeAbsent(),
		)
	})

	test("a member's empty board offers the first widget", () => {
		scene(
			{ update: pageUpdate, view },
			given(ready(MEMBER, {}, board([]))),
			themed(),
			expectView(role("button", { name: "Add your first widget" })).toExist(),
		)
	})
})
