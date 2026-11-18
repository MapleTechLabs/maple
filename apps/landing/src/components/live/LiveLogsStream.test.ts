import * as LogsStream from "@maple/views/ui/logs/logs-stream"
import { describe, expect, it } from "vitest"
import renderer from "../../foldkit-island/server"
import { LiveLogsStream, update } from "./LiveLogsStream"

describe("Logs stream island", () => {
	it("renders every example log with its severity before the browser mounts", async () => {
		const { html } = await renderer.renderToStaticMarkup(LiveLogsStream, {})

		expect(html).toContain("card declined: insufficient_funds")
		expect(html).toContain("POST /api/feedback 201")
		expect(html).toContain("ERROR")
		expect(html).toContain("16 logs")
	})

	it("expands a clicked row in place, and a second click folds it, since the landing has no log page", () => {
		const model = LogsStream.init("test", [])
		const opened = update(model, LogsStream.Message.ClickedRow({ index: 3 })).model
		const closed = update(opened, LogsStream.Message.ClickedRow({ index: 3 })).model

		expect(opened.expandedRows).toEqual([3])
		expect(closed.expandedRows).toEqual([])
	})

	it("keeps an expanded row open when its Details button is clicked", () => {
		const opened = update(LogsStream.init("test", []), LogsStream.Message.ClickedRow({ index: 3 })).model
		const details = update(opened, LogsStream.Message.ClickedDetails({ index: 3 })).model

		expect(details.expandedRows).toEqual([3])
	})
})
