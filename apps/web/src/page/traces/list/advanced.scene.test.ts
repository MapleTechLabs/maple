import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { autocompleteOf } from "./advanced"
import { listboxPlacement } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const windowed = (): Model =>
	pageUpdate(
		init({ search: {} }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load", timeZone: "UTC" }),
	).model

const urlOf = (result: { readonly outMessage?: unknown }) =>
	typeof result.outMessage === "object" && result.outMessage !== null && "url" in result.outMessage
		? decodeURIComponent(String(result.outMessage.url))
		: ""

describe("traces advanced filter", () => {
	test("opening starts the autocomplete lookups once, and focus shows key suggestions", () => {
		const opened = pageUpdate(windowed(), Message.ClickedAdvancedFilter())
		expect(names(opened.commands).filter((name) => name === "FetchTracesAdvancedLookup")).toHaveLength(6)
		expect(opened.model.advanced.dialog.isOpen).toBe(true)
		const focused = pageUpdate(opened.model, Message.FocusedAdvanced({ cursor: 0 })).model
		expect(autocompleteOf(focused).suggestions[0]?.label).toBe("service.name")
	})

	test("Enter on a suggestion inserts it; Apply writes the clause and the params it sets", () => {
		const opened = pageUpdate(windowed(), Message.ClickedAdvancedFilter()).model
		const focused = pageUpdate(opened, Message.FocusedAdvanced({ cursor: 0 })).model
		const picked = pageUpdate(focused, Message.PressedAdvancedKey({ key: "Enter" })).model
		expect(picked.advanced.draft.startsWith("service.name")).toBe(true)
		const typed = pageUpdate(
			picked,
			Message.EditedAdvanced({ value: 'service.name = "storefront"', cursor: 27 }),
		)
		const applied = pageUpdate(typed.model, Message.SubmittedAdvanced())
		expect(urlOf(applied)).toContain("whereClause=service.name")
		expect(urlOf(applied)).toContain('services=["storefront"]')
	})

	test("Escape hides the suggestions until the caret moves", () => {
		const opened = pageUpdate(windowed(), Message.ClickedAdvancedFilter()).model
		const focused = pageUpdate(opened, Message.FocusedAdvanced({ cursor: 0 })).model
		const dismissed = pageUpdate(focused, Message.PressedAdvancedKey({ key: "Escape" })).model
		expect(dismissed.advanced.isDismissed).toBe(true)
		expect(
			pageUpdate(dismissed, Message.MovedAdvancedCursor({ cursor: 0 })).model.advanced.isDismissed,
		).toBe(false)
	})

	test("the suggestion listbox flips above a textarea near the bottom and back, one side at a time", () => {
		const rect = (top: number) => ({ left: 10, width: 300, top, bottom: top + 40 })
		const below = listboxPlacement(rect(100), 800)
		expect([below.top, below.bottom]).toEqual(["144px", ""])
		const above = listboxPlacement(rect(700), 800)
		expect([above.top, above.bottom]).toEqual(["", "104px"])
	})
})
