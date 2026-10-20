import { describe, expect, test } from "vitest"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

// The mermaid toolbar's download menu and fullscreen dialog (Streamdown's `ct` and `cn`).

const NO_CONTEXT = { preamble: "" }
const step = (model: Model, message: Message) => update(model, message, NO_CONTEXT)
const fresh = () => init("default", "org_acme:default").model
const CODE = "flowchart LR\n  a --> b"
const INLINE = `inline:${CODE}`

describe("chat diagrams", () => {
	test("Download opens the format menu, a second press or a press outside closes it", () => {
		const opened = step(fresh(), Message.ToggledDiagramMenu({ menuId: INLINE })).model
		expect(opened.diagramMenu).toBe(INLINE)
		expect(step(opened, Message.ToggledDiagramMenu({ menuId: INLINE })).model.diagramMenu).toBeNull()
		expect(step(opened, Message.PressedOutsideDiagramMenu({ menuId: INLINE })).model.diagramMenu).toBeNull()
		// A press outside another menu leaves this one open.
		expect(step(opened, Message.PressedOutsideDiagramMenu({ menuId: `fullscreen:${CODE}` })).model.diagramMenu).toBe(INLINE)
	})

	test("MMD closes the menu at once; SVG and PNG close it once the file was saved", () => {
		const opened = step(fresh(), Message.ToggledDiagramMenu({ menuId: INLINE })).model
		const mmd = step(opened, Message.ClickedDiagramFormat({ menuId: INLINE, code: CODE, format: "mmd" }))
		expect(mmd.model.diagramMenu).toBeNull()
		expect(mmd.commands?.map((command) => command.name)).toEqual(["DownloadChatDiagram"])
		const svg = step(opened, Message.ClickedDiagramFormat({ menuId: INLINE, code: CODE, format: "svg" }))
		expect(svg.model.diagramMenu).toBe(INLINE)
		expect(step(svg.model, Message.CompletedDownloadDiagram({ menuId: INLINE, isSaved: false })).model.diagramMenu).toBe(INLINE)
		expect(step(svg.model, Message.CompletedDownloadDiagram({ menuId: INLINE, isSaved: true })).model.diagramMenu).toBeNull()
	})

	test("View fullscreen shows the diagram until it is closed", () => {
		const shown = step(fresh(), Message.ClickedDiagramFullscreen({ code: CODE })).model
		expect(shown.fullscreenDiagram).toBe(CODE)
		expect(step(shown, Message.ClosedDiagramFullscreen()).model.fullscreenDiagram).toBeNull()
	})
})
