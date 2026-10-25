import { expect as expectView, given, role, scene, text } from "foldkit/scene"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { describe, test } from "vitest"
import { type LoadFailure, toLoadFailure } from "../../data/load-failure"
import { filterSidebarError } from "./filter-sidebar"

const Message = defineMessageUnion({ ClickedRetry: {} })
type Message = typeof Message.Type

type Model = Readonly<{ facets: LoadFailure; main: LoadFailure | undefined }>

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	filterSidebarError(h, model.facets, Message.ClickedRetry(), model.main)
const update = (model: Model) => ({ model, commands: [] })

const facets = toLoadFailure("facets read failed")

describe("filter sidebar error", () => {
	test("the main panel showing the same failure leaves the rail one quiet status line", () => {
		scene(
			{ update, view },
			given<Model>({ facets, main: facets }),
			expectView(role("status")).toExist(),
			expectView(role("alert")).not.toExist(),
		)
	})

	test("a facets failure the main panel does not show keeps its reason in the rail", () => {
		for (const main of [undefined, { ...facets, message: "Another reason" }]) {
			scene(
				{ update, view },
				given<Model>({ facets, main }),
				expectView(role("alert")).toExist(),
				expectView(text(facets.title)).toExist(),
			)
		}
	})
})
