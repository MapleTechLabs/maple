import { describe, expect, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import { formatElapsed } from "../kit/view-tool"
import { Message } from "./message"
import { init, update } from "./update"

// A sub-agent row's sheet (`TaskCard`'s `Sheet`) and the running clock's wording.

const step = (model: ReturnType<typeof init>["model"], message: Message) =>
	update(model, message, { preamble: "" })

describe("chat sub-agent sheets", () => {
	test("each row's trigger opens its own sheet; Close shuts it", () => {
		const fresh = init("default", "org_acme:default").model
		const opened = step(
			fresh,
			Message.GotTaskSheetMessage({ toolCallId: "t1", message: Dialog.Message.ClickedTrigger() }),
		).model
		expect(opened.taskSheets["t1"]?.isOpen).toBe(true)
		expect(opened.taskSheets["t0"]).toBeUndefined()
		const closed = step(
			opened,
			Message.GotTaskSheetMessage({ toolCallId: "t1", message: Dialog.Message.ClickedClose() }),
		).model
		expect(closed.taskSheets["t1"]?.isOpen).toBe(false)
	})

	test("the clock stays silent under two seconds, then counts seconds and minutes", () => {
		expect(formatElapsed(1)).toBe("")
		expect(formatElapsed(4)).toBe("4s")
		expect(formatElapsed(72)).toBe("1m 12s")
	})
})
