import { expect as expectView, given, role, scene } from "foldkit/scene"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { describe, test } from "vitest"
import { type LoadFailure, toLoadFailure } from "../data/load-failure"
import { errorState } from "./error-state"

const Message = defineMessageUnion({ ClickedRetry: {} })
type Message = typeof Message.Type

type Model = Readonly<{ hidesRetryButton: boolean }>

// `retryable: false` skips the auto-retry Mount; the button only needs `recovery: "retry"`.
const failure: LoadFailure = { ...toLoadFailure("boom"), recovery: "retry", retryable: false }

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	errorState(h, {
		failure,
		variant: "quiet",
		onRetry: Message.ClickedRetry(),
		hidesRetryButton: model.hidesRetryButton,
	})
const update = (model: Model) => ({ model, commands: [] })

describe("quiet error state", () => {
	test("offers its own retry button by default", () => {
		scene({ update, view }, given<Model>({ hidesRetryButton: false }), expectView(role("button")).toExist())
	})

	test("draws no button when a page-level strip already offers Try again", () => {
		scene(
			{ update, view },
			given<Model>({ hidesRetryButton: true }),
			expectView(role("button")).not.toExist(),
			expectView(role("status")).toExist(),
		)
	})
})
