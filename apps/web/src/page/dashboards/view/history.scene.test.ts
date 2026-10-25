import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import { type PageContext } from "../../contract"
import { FetchSnapshot, FetchVersions, RestoreVersion } from "./command-history"
import { Message } from "./message"
import type { Model } from "./model"
import { isEditing } from "./mode"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_hist",
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

const openHistoryMessage = Message.GotMoreMenuMessage({
	message: { _tag: "ClickedItem", index: 4, item: { kind: "Item", value: "history" } },
})

const ROUTE = { dashboardId: "dash_hist", search: { mode: "edit" as const } }

const withVersions = (): Model =>
	[
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		openHistoryMessage,
		Message.CompletedFetchVersions({ generation: 1, result: Result.succeed([version]) }),
	].reduce((model, message) => pageUpdate(model, message).model, init(ROUTE, context).model)

describe("dashboard version history", () => {
	test("opening the panel reads the versions once", () => {
		const ready = [
			Message.CompletedReadClock({ nowMs: 0 }),
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		].reduce((model, message) => pageUpdate(model, message).model, init(ROUTE, context).model)
		const opened = pageUpdate(ready, openHistoryMessage)
		expect(names(opened.commands)).toEqual([FetchVersions.name])
		expect(names(pageUpdate(opened.model, openHistoryMessage).commands)).toEqual([])
	})

	test("a previewed version loads its snapshot and leaves edit mode", () => {
		const model = withVersions()
		expect(isEditing(model)).toBe(true)
		const previewed = pageUpdate(model, Message.ClickedVersion({ versionId: version.id }))
		expect(names(previewed.commands)).toEqual([FetchSnapshot.name])
		expect(isEditing(previewed.model)).toBe(false)
		expect(isEditing(pageUpdate(previewed.model, Message.ClickedCancelPreview()).model)).toBe(true)
	})

	test("a confirmed restore writes once, then clears the preview and re-reads the list", () => {
		const previewed = pageUpdate(withVersions(), Message.ClickedVersion({ versionId: version.id })).model
		const confirmed = pageUpdate(previewed, Message.ConfirmedRestore())
		expect(names(confirmed.commands)).toEqual([RestoreVersion.name])
		expect(names(pageUpdate(confirmed.model, Message.ConfirmedRestore()).commands)).toEqual([])
		const done = pageUpdate(confirmed.model, Message.CompletedRestore({ versionNumber: 2, error: null }))
		expect(done.model.history.previewed).toBeNull()
		expect(names(done.commands)).toContain(FetchVersions.name)
		expect(done.outMessage?._tag).toBe("RequestedToast")
	})

	test("a version list read before a restore is dropped when it lands after the re-read", () => {
		const previewed = pageUpdate(withVersions(), Message.ClickedVersion({ versionId: version.id })).model
		const confirmed = pageUpdate(previewed, Message.ConfirmedRestore()).model
		const done = pageUpdate(confirmed, Message.CompletedRestore({ versionNumber: 2, error: null })).model
		const restoredRow = { ...version, id: "ver_restored", versionNumber: 3, isRestore: true }
		const fresh = pageUpdate(done, Message.CompletedFetchVersions({ generation: 2, result: Result.succeed([restoredRow, version]) })).model
		const late = pageUpdate(fresh, Message.CompletedFetchVersions({ generation: 1, result: Result.succeed([version]) })).model
		expect(AsyncData.getOrElse(late.history.versions, () => []).map((row) => row.id)).toEqual(["ver_restored", version.id])
	})
})
