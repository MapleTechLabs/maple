import { expect as expectView, given, Mount, role, scene } from "foldkit/scene"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { describe, expect, test } from "vitest"
import { type LoadFailure, toLoadFailure } from "../data/load-failure"
import {
	autoRetryMessage,
	errorState,
	FAILURE_SENTENCE,
	failureKind,
	failureSentence,
	MountNetworkAutoRetry,
} from "./error-state"

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

describe("failureSentence", () => {
	const base = toLoadFailure("boom")

	test("a dropped, timed-out or failing backend reads as one outage sentence", () => {
		const outage = { ...base, type: "api_error" as const, recovery: "retry" as const, retryable: true }
		expect(
			failureSentence({
				...outage,
				code: "network_unreachable",
				message: "Maple's API is unreachable.",
			}),
		).toBe(FAILURE_SENTENCE.backend)
		expect(
			failureSentence({ ...outage, code: "request_timeout", message: "The API did not respond." }),
		).toBe(FAILURE_SENTENCE.backend)
	})

	test("a failing warehouse reads as a query failure, not a backend outage", () => {
		const outage = { ...base, type: "api_error" as const, recovery: "retry" as const, retryable: true }
		const warehouse = failureSentence({
			...outage,
			code: "warehouse_unavailable",
			message: "The query backend is unreachable. Retry in a few seconds.",
		})
		expect(warehouse).toBe(FAILURE_SENTENCE.warehouse)
		expect(warehouse).not.toBe(FAILURE_SENTENCE.backend)
		expect(
			toLoadFailure({ error: { ...outage, code: "warehouse_query_failed", message: "Query failed." } })
				.message,
		).toBe(FAILURE_SENTENCE.warehouse)
	})

	test("an unrecognised failure reads as the unknown sentence, without 'or reload'", () => {
		expect(failureSentence(base)).toBe(FAILURE_SENTENCE.unknown)
	})

	test("a fixable failure keeps its own guidance", () => {
		const fixable = {
			...base,
			code: "range_too_wide",
			type: "invalid_request_error" as const,
			recovery: "fix_request" as const,
			retryable: false,
			message: "Pick a shorter range.",
		}
		expect(failureSentence(fixable)).toBe("Pick a shorter range.")
	})
})

describe("one retry affordance", () => {
	const panel = (h: HtmlBuilder<Message>): Html =>
		errorState(h, { failure, message: "Saved. Try again or reload.", onRetry: Message.ClickedRetry() })

	test("a drawn Try again button replaces the message's own retry advice", () => {
		scene(
			{ update, view: (_model: Model, h: HtmlBuilder<Message>) => panel(h) },
			given<Model>({ hidesRetryButton: false }),
			expectView(role("button", { name: "Try again" })).toExist(),
			expectView(role("alert")).toContainText("Saved."),
			expectView(role("alert")).not.toContainText("reload"),
		)
	})

	test("an auto-retrying failure still says so beside the Try again button", () => {
		const retrying: LoadFailure = { ...failure, type: "api_error", retryable: true }
		scene(
			{
				update,
				view: (_model: Model, h: HtmlBuilder<Message>) =>
					errorState(h, { failure: retrying, onRetry: Message.ClickedRetry() }),
			},
			given<Model>({ hidesRetryButton: false }),
			Mount.resolve(
				MountNetworkAutoRetry({ retryKey: JSON.stringify(Message.ClickedRetry()) }),
				Message.ClickedRetry(),
			),
			expectView(role("button", { name: "Try again" })).toExist(),
			expectView(role("alert")).toContainText("Retrying automatically"),
		)
	})
})
