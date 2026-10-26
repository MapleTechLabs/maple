import { expect as expectView, given, role, scene } from "foldkit/scene"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { describe, expect, test } from "vitest"
import { type LoadFailure, toLoadFailure } from "../data/load-failure"
import { autoRetryMessage, errorState, failureKind } from "./error-state"

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
		scene(
			{ update, view },
			given<Model>({ hidesRetryButton: false }),
			expectView(role("button")).toExist(),
		)
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

describe("failureKind", () => {
	const base = toLoadFailure("boom")

	test("a refused permission or expired session reads as no access", () => {
		expect(
			failureKind({ ...base, type: "permission_error", recovery: "request_access", retryable: false }),
		).toBe("access")
		expect(
			failureKind({
				...base,
				type: "authentication_error",
				recovery: "reauthenticate",
				retryable: false,
			}),
		).toBe("access")
	})

	test("a query the reader can narrow reads as fixable", () => {
		expect(
			failureKind({
				...base,
				type: "invalid_request_error",
				recovery: "fix_request",
				retryable: false,
			}),
		).toBe("fixable")
	})

	test("an outage, or anything unrecognised, reads as an outage", () => {
		expect(failureKind({ ...base, type: "api_error", recovery: "retry", retryable: true })).toBe("outage")
		expect(failureKind(base)).toBe("outage")
	})
})

describe("autoRetryMessage", () => {
	test("swaps a retry-soon ending for the one auto-retry note", () => {
		expect(autoRetryMessage("The query backend is unreachable. Retry in a few seconds.")).toBe(
			"The query backend is unreachable. Retrying automatically…",
		)
		expect(autoRetryMessage("The API did not respond in time. Try again when you're ready.")).toBe(
			"The API did not respond in time. Retrying automatically…",
		)
	})

	test("keeps guidance that is not about waiting", () => {
		expect(autoRetryMessage("Retry with a narrower time range.")).toBe(
			"Retry with a narrower time range. Retrying automatically…",
		)
	})

	test("puts a note after the cause and before the retry line", () => {
		expect(
			autoRetryMessage(
				"Maple's API is unreachable. Retry shortly.",
				"Nothing you've built is affected.",
			),
		).toBe("Maple's API is unreachable. Nothing you've built is affected. Retrying automatically…")
	})
})
