import type { Html, HtmlBuilder } from "foldkit/html"
import { expect, expectHandled, expectIgnored, given, keydown, role, scene, text } from "foldkit/scene"
import { describe, test } from "vitest"
import { Message } from "./message"
import { commentComposer } from "./view-activity"

// The composer alone, counting the submits its keyboard shortcut sends.
type Model = { readonly draft: string; readonly submits: number }

const update = (model: Model, message: Message) => ({
	model: message._tag === "ClickedComment" ? { ...model, submits: model.submits + 1 } : model,
	commands: [],
})
const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[],
		[
			commentComposer(h, { draft: model.draft, isPosting: false, participants: [] }),
			h.output([], [`${model.submits} submits`]),
		],
	)

describe("issue comment composer", () => {
	test("Cmd+Enter and Ctrl+Enter comment; a plain Enter does not", () => {
		scene(
			{ update, view },
			given<Model>({ draft: "Found it", submits: 0 }),
			keydown(role("textbox"), "Enter"),
			expectIgnored(),
			keydown(role("textbox"), "Enter", { metaKey: true }),
			expectHandled(),
			keydown(role("textbox"), "Enter", { ctrlKey: true }),
			expectHandled(),
			expect(text("2 submits")).toExist(),
		)
	})
})
