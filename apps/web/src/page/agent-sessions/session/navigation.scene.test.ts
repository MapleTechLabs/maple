import { OrgId } from "@maple/domain"
import { agentSpan, llmSpan, toolSpan, userMessages } from "@maple/agent-sessions/testing"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import { PageOutMessage, type PageContext } from "../../contract"
import { toWire } from "../../../lab/session-lab"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const SESSION = "5f1c2a90-3b7e-4c1d-9a2f-7e0d4b6c8a11"

const SPANS = toWire(
	[
		agentSpan({ spanId: "agent", traceId: "trace-1", startMs: 0, durationMs: 9_000 }),
		llmSpan({
			spanId: "chat",
			parentSpanId: "agent",
			traceId: "trace-1",
			startMs: 100,
			durationMs: 2_000,
			model: "claude-opus-5",
			genAi: { inputMessages: userMessages("fix the flaky retry test") },
		}),
		toolSpan({
			spanId: "tool",
			parentSpanId: "agent",
			traceId: "trace-1",
			startMs: 3_000,
			durationMs: 500,
		}),
	],
	SESSION,
)

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

/** Entered on `search` with the fixture as the session's only page. */
const loaded = (search: Model["search"]) => {
	const { model } = init({ sessionId: SESSION, search }, context)
	return pageUpdate(
		model,
		Message.CompletedFetchFirstPage({
			key: model.firstPage.key ?? "",
			result: Result.succeed({ data: SPANS, nextCursor: null }),
		}),
	)
}

describe("agent session span cursor, landing and popover", () => {
	test("a pasted ?span= in Traces centres its row once, puts the cursor on it and opens the popover", () => {
		const { model } = loaded({ view: "trace", span: "chat" })
		expect(model.landed).toBe(true)
		expect(model.focusedSpanId).toBe("chat")
		expect(model.scroll).toMatchObject({ align: "center", reveal: true })
		expect(model.spanDialog.isOpen).toBe(true)
		const again = pageUpdate(
			model,
			Message.ChangedWaterfallWindow({ window: { items: [], totalSize: 0, scrollMargin: 0 } }),
		)
		expect(again.model.scroll).toEqual(model.scroll)
	})

	test("a pasted ?span= in the transcript centres its block and opens no popover", () => {
		const { model } = loaded({ view: "transcript", span: "chat" })
		expect(model.landed).toBe(true)
		expect(model.scroll).toMatchObject({ align: "center", reveal: false })
		expect(model.spanDialog.isOpen).toBe(false)
	})

	test("j walks the span rows from the top and Enter opens the one under the cursor", () => {
		const { model } = loaded({ view: "trace" })
		const first = pageUpdate(model, Message.PressedSpanKey({ key: "Next" })).model
		expect(first.focusedSpanId).toBe("agent")
		const second = pageUpdate(first, Message.PressedSpanKey({ key: "Next" })).model
		expect(second.focusedSpanId).toBe("chat")
		expect(pageUpdate(second, Message.PressedSpanKey({ key: "Previous" })).model.focusedSpanId).toBe(
			"agent",
		)
		expect(pageUpdate(second, Message.PressedSpanKey({ key: "Open" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/agent-sessions/${SESSION}?view=trace&span=chat`,
				isReplace: false,
			}),
		)
	})

	test("Escape closes an open span, then clears the cursor", () => {
		const { model } = loaded({ view: "trace", span: "chat" })
		const closed = pageUpdate(model, Message.PressedSpanKey({ key: "Escape" }))
		expect(closed.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/agent-sessions/${SESSION}?view=trace`,
				isReplace: true,
			}),
		)
		expect(closed.model.spanDialog.isOpen).toBe(false)
		expect(
			pageUpdate(closed.model, Message.PressedSpanKey({ key: "Escape" })).model.focusedSpanId,
		).toBeNull()
	})

	test("the dialog's own Escape drops ?span= from the URL", () => {
		const { model } = loaded({ view: "trace", span: "chat" })
		const step = pageUpdate(
			model,
			Message.GotSpanDialogMessage({ message: Dialog.Message.PressedEscape() }),
		)
		expect(step.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/agent-sessions/${SESSION}?view=trace`,
				isReplace: true,
			}),
		)
	})

	test("the Details and Logs tabs read once they are open, and only once", () => {
		const { model } = loaded({ view: "trace", span: "chat" })
		const details = pageUpdate(model, Message.PickedSpanTab({ tab: "details" }))
		expect(names(details.commands)).toContain("FetchSpanDetail")
		expect(
			names(pageUpdate(details.model, Message.PickedSpanTab({ tab: "details" })).commands),
		).not.toContain("FetchSpanDetail")
		expect(names(pageUpdate(details.model, Message.PickedSpanTab({ tab: "logs" })).commands)).toContain(
			"FetchSpanLogs",
		)
	})

	test("Open in Traces view closes the popover, crosses and lands on the row", () => {
		const { model } = loaded({ span: "tool" })
		const crossed = pageUpdate(model, Message.ClickedOpenInTraceView())
		expect(crossed.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/agent-sessions/${SESSION}?view=trace`,
				isReplace: false,
			}),
		)
		const arrived = routeChanged(
			crossed.model,
			{ sessionId: SESSION, search: { view: "trace" } },
			context,
		).model
		expect(arrived.focusedSpanId).toBe("tool")
		expect(arrived.spanDialog.isOpen).toBe(false)
	})
})
