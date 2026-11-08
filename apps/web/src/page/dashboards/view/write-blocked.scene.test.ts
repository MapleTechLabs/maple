import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import { Mount, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import * as RadioGroup from "@maple/views/ui/radio-group"
import { MeasureGrid } from "./command"
import { WriteShare } from "./command-share"
import { ShareMessage } from "./share"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// History stays browsable while writes are off, but a version cannot be restored; sharing still works.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const DASHBOARD_ID = "dash_hist"
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const view = withViewInputs(pageView, { context })()
const mounted = () => [
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
	Mount.resolve(MeasureGrid, Message.MeasuredGrid({ width: 1200 })),
]

const document = Schema.decodeSync(DashboardDocument)({
	id: DASHBOARD_ID,
	name: "History",
	timeRange: { type: "relative", value: "6h" },
	widgets: [],
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

const clocked = (): Model =>
	pageUpdate(
		init({ dashboardId: DASHBOARD_ID, search: { mode: "edit" } }, context).model,
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
	).model

/** Opens history, then previews v2 with its snapshot loaded. */
const previewV2 = (model: Model): Model =>
	run(model, [
		Message.GotMoreMenuMessage({
			message: { _tag: "ClickedItem", index: 4, item: { kind: "Item", value: "history" } },
		}),
		Message.CompletedFetchVersions({
			generation: model.history.versionsGeneration + 1,
			nowMs: 0,
			result: Result.succeed([version]),
		}),
		Message.ClickedVersion({ versionId: version.id }),
		Message.CompletedFetchSnapshot({ versionId: version.id, result: Result.succeed(document) }),
	])

const onSnapshot = (): Model =>
	run(clocked(), [
		Message.TimedOutLiveDashboard({ orgId }),
		Message.CompletedFetchDashboardFallback({
			dashboardId: DASHBOARD_ID,
			result: Result.succeed(document),
		}),
	])

const afterFailedWrite = (): Model =>
	run(clocked(), [
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		Message.CompletedWrite({ result: Result.fail("Conflict") }),
	])

describe.each([
	["the board is an HTTP snapshot", onSnapshot],
	["a write failed", afterFailedWrite],
])("restoring a version while %s", (_, blocked) => {
	test("the preview loads, Restore is disabled with its reason, and a confirm writes nothing", () => {
		const previewed = previewV2(blocked())
		expect(previewed.history.previewed?.id).toBe(version.id)
		expect(names(pageUpdate(previewed, Message.ConfirmedRestore()).commands)).toEqual([])
		expect(pageUpdate(previewed, Message.ClickedRestoreVersion()).model.history.restoreDialog).toEqual(
			previewed.history.restoreDialog,
		)
		scene(
			{ update: pageUpdate, view },
			given(previewed),
			...mounted(),
			expectView(role("button", { name: /Restore this version/ })).toBeDisabled(),
			expectView(text("Restore is off while editing is unavailable")).toExist(),
		)
	})
})

test("with writes on, Restore stays enabled", () => {
	const previewed = previewV2(
		run(clocked(), [Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) })]),
	)
	scene(
		{ update: pageUpdate, view },
		given(previewed),
		...mounted(),
		expectView(role("button", { name: /Restore this version/ })).toBeEnabled(),
		expectView(text("Restore is off while editing is unavailable")).toBeAbsent(),
	)
})

test("sharing stays available on a snapshot: share links are not board writes", () => {
	const share = (message: ShareMessage) => Message.GotShareMessage({ message })
	const listed = run(onSnapshot(), [
		share(ShareMessage.CompletedFetchShares({ seq: 1, result: Result.succeed([]) })),
		Message.GotMoreMenuMessage({
			message: { _tag: "ClickedItem", index: 0, item: { kind: "Item", value: "share" } },
		}),
	])
	const picked = pageUpdate(
		listed,
		share(
			ShareMessage.GotAccessMessage({ message: RadioGroup.Message.SelectedRadio({ value: "public" }) }),
		),
	)
	expect(names(picked.commands)).toEqual([WriteShare.name])
})
