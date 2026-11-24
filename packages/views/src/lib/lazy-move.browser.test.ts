import { Schema } from "effect"
import { Runtime } from "foldkit"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { describe, expect, test } from "vitest"

// A cached subtree that moves between two parents in one render (a page rail going from its sheet
// to the inline sidebar when the window widens) must not share VNodes across the move: snabbdom
// creates the new controls, then destroys the old parent through the same VNodes and strips the
// new controls' listeners. Passing the position as a lazy argument gives each place its own tree.

const Model = Schema.Struct({ isWide: Schema.Boolean, clicks: Schema.Number })
type Model = typeof Model.Type

const Message = defineMessageUnion({ Widened: {}, Clicked: {} })
type Message = typeof Message.Type

const rail = (h: HtmlBuilder<Message>, _isWide: boolean): Html =>
	h.button([h.Id("rail-toggle"), h.OnClick(Message.Clicked())], ["Toggle"])

const mount = (railArgs: (h: HtmlBuilder<Message>, model: Model) => Html) => {
	const container = document.createElement("div")
	container.id = "lazy-move-app"
	document.body.append(container)
	Runtime.run(
		Runtime.makeElement({
			Model,
			container,
			init: () => ({ model: { isWide: false, clicks: 0 } }),
			update: (model: Model, message: Message) => ({
				model:
					message._tag === "Widened"
						? { ...model, isWide: true }
						: { ...model, clicks: model.clicks + 1 },
			}),
			// The inline place comes before the sheet, as the shell's sidebar does.
			view: (model: Model, h: HtmlBuilder<Message>) =>
				h.div(
					[h.Id("lazy-move-root")],
					[
						model.isWide ? h.aside([h.Key("inline")], [railArgs(h, model)]) : null,
						h.output([h.Id("clicks")], [String(model.clicks)]),
						h.button([h.Id("widen"), h.OnClick(Message.Widened())], ["Widen"]),
						model.isWide ? null : h.div([h.Key("sheet")], [railArgs(h, model)]),
					],
				),
		}),
	)
	// The first render replaces the container with the view's root.
	const byId = (id: string) => document.querySelector<HTMLElement>(`#lazy-move-root #${id}`)
	return { byId, remove: () => document.getElementById("lazy-move-root")?.remove() }
}

describe("a lazy subtree moved between parents", () => {
	test("keeps its handlers when its position is one of the lazy arguments", async () => {
		const slot = createLazy()
		const app = mount((h, model) => slot(rail, [h, model.isWide]))
		await expect.poll(() => app.byId("rail-toggle")).not.toBeNull()
		app.byId("widen")?.click()
		await expect.poll(() => app.byId("rail-toggle")?.closest("aside")).not.toBeNull()
		app.byId("rail-toggle")?.click()
		await expect.poll(() => app.byId("clicks")?.textContent).toBe("1")
		app.remove()
	})
})
