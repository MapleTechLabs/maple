import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Schema, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { DismissImportReport } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

// The "Imported from Grafana" notice: Show / Hide is local, Dismiss writes the report away.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => update(current, message, context).model)

const document = Schema.decodeSync(DashboardDocument)({
	id: "dash_imported",
	name: "Imported",
	timeRange: { type: "relative", value: "6h" },
	widgets: [],
	importReport: { source: "grafana", items: ['Variable "route" became a text box.'] },
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

const ready = (): Model =>
	run(init({ dashboardId: "dash_imported", search: {} }, context).model, [
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
	])

describe("the import report notice", () => {
	test("starts collapsed and toggles its list without writing", () => {
		const board = ready()
		expect(board.isImportReportOpen).toBe(false)
		const opened = update(board, Message.ToggledImportReport(), context)
		expect(opened.model.isImportReportOpen).toBe(true)
		expect(opened.commands ?? []).toEqual([])
		expect(run(opened.model, [Message.ToggledImportReport()]).isImportReportOpen).toBe(false)
	})

	test("dismissing it removes the report from the dashboard", () => {
		const dismissed = update(ready(), Message.ClickedDismissImportReport(), context)
		expect(Arr.map(dismissed.commands ?? [], ({ name }) => name)).toEqual([DismissImportReport.name])
	})
})
