import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { CaretMessage } from "./where-editor"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const anchor = { left: 0, top: 0, bottom: 32, width: 400, viewportHeight: 900 }
const pageUpdate = (model: Model, message: Message) => update(model, message, context).model

/** The editor focused with `text` typed and the caret at its end. */
const typed = (text: string): Model => {
	const base = init({ metricName: "http.server.request.duration", search: {} }, context).model
	const focused = pageUpdate(
		base,
		Message.GotCaretMessage({ message: CaretMessage.FocusedEditor({ cursor: 0, anchor }) }),
	)
	const changed = pageUpdate(focused, Message.ChangedWhereInput({ value: text }))
	return pageUpdate(
		changed,
		Message.GotCaretMessage({
			message: CaretMessage.MovedCaret({ cursor: text.length, anchor, keyUp: null }),
		}),
	)
}

describe("where editor suggestions", () => {
	test("Enter on an open list applies the active suggestion and moves the caret past it", () => {
		const open = typed("metric")
		const applied = pageUpdate(open, Message.PressedWhereEnterOnList())
		expect(applied.whereInput).not.toBe("metric")
		expect(applied.whereEditor.cursor).toBeGreaterThan("metric".length)
	})

	test("Tab moves the caret like accepting, but leaves the text (legacy's hook-level accept)", () => {
		const open = typed("metric")
		const tabbed = pageUpdate(open, Message.PressedWhereTab())
		expect(tabbed.whereInput).toBe("metric")
	})

	test("Escape dismisses the list until the caret moves again", () => {
		const dismissed = pageUpdate(typed("metric"), Message.DismissedWhereSuggestions())
		expect(dismissed.whereEditor.isDismissed).toBe(true)
		const moved = pageUpdate(
			dismissed,
			Message.GotCaretMessage({
				message: CaretMessage.MovedCaret({ cursor: 2, anchor, keyUp: "Escape" }),
			}),
		)
		expect(moved.whereEditor.isDismissed).toBe(false)
	})

	test("arrows wrap through the list and are ignored once it is closed", () => {
		const open = typed("")
		const up = pageUpdate(open, Message.MovedWhereSuggestion({ step: -1 }))
		expect(up.whereEditor.activeIndex).toBeGreaterThan(0)
		const blurred = pageUpdate(open, Message.GotCaretMessage({ message: CaretMessage.BlurredEditor() }))
		expect(pageUpdate(blurred, Message.MovedWhereSuggestion({ step: 1 })).whereEditor.activeIndex).toBe(0)
	})
})
