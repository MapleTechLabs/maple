import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import * as TagEditor from "../kit/tag-editor"
import * as ManagerModel from "../kit/variables-manager/model"
import { AddWidget, SaveTags, SaveVariables } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

// What the board does with dialogs already open when a background write fails.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => pageUpdate(current, message).model, model)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_rw",
	name: "Writes",
	timeRange: { type: "relative", value: "6h" },
	widgets: [],
	variables: [{ name: "env", type: "custom", options: [{ value: "production" }] }],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

const menuPick = (value: string) =>
	Message.GotMoreMenuMessage({ message: { _tag: "ClickedItem", index: 0, item: { kind: "Item", value } } })
const failedWrite = Message.CompletedWrite({ result: Result.fail("Conflict") })

const ready = (): Model =>
	run(init({ dashboardId: "dash_rw", search: { mode: "edit" } }, context).model, [
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
	])

describe("a write failing behind an open dialog", () => {
	test("the variables dialog's Save still writes", () => {
		const failed = run(ready(), [menuPick("variables"), failedWrite])
		const saved = pageUpdate(failed, Message.GotVariablesManagerMessage({ message: ManagerModel.Message.SubmittedForm() }))
		expect(names(saved.commands)).toContain(SaveVariables.name)
	})

	test("the tag editor's Save still writes", () => {
		const failed = run(ready(), [menuPick("tags"), failedWrite])
		const saved = pageUpdate(failed, Message.GotTagEditorMessage({ message: TagEditor.Message.ClickedSaveTags() }))
		expect(names(saved.commands)).toContain(SaveTags.name)
	})

	test("the widget picker closes, and a pick then says editing is unavailable", () => {
		const failed = run(ready(), [Message.ClickedAddWidget(), failedWrite])
		expect(failed.pickerDialog.isOpen).toBe(false)
		const picked = pageUpdate(failed, Message.ClickedWidgetPreset({ presetId: "errors-total" }))
		expect(names(picked.commands)).not.toContain(AddWidget.name)
		expect(picked.outMessage?._tag).toBe("RequestedToast")
	})
})
