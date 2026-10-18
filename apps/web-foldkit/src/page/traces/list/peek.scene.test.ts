import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model, TraceRow, TracesPage } from "./model"
import { init, routeChanged, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)

const trace = (index: number): TraceRow => ({
	traceId: index.toString(16).padStart(32, "0"),
	spanId: `span-${index}`,
	isRootSpan: true,
	startTime: "2026-10-01 11:59:00",
	durationMs: 120,
	spanCount: 4,
	services: ["storefront"],
	rootSpanName: "GET /cart",
	rootName: "GET /cart",
	rootKind: "Server",
	rootAttributes: {},
	httpStatusCode: 200,
	hasError: false,
})

const loaded = (): Model => {
	const base = pageUpdate(
		init({ search: {} }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
	).model
	const first: TracesPage = { rows: [trace(1), trace(2), trace(3)], scannedCount: 3, hiddenCount: 0 }
	return pageUpdate(
		base,
		Message.CompletedFetchFirstPage({ key: base.firstPage.key ?? "", result: Result.succeed(first) }),
	).model
}

const urlOf = (result: { readonly outMessage?: unknown }) =>
	typeof result.outMessage === "object" && result.outMessage !== null && "url" in result.outMessage
		? String(result.outMessage.url)
		: ""

describe("traces peek", () => {
	test("a plain row click writes the peek params; the route then opens the sheet on that trace", () => {
		const model = loaded()
		const clicked = pageUpdate(model, Message.ClickedPeekRow({ index: 1 }))
		expect(urlOf(clicked)).toContain(`peek=${trace(2).traceId}`)
		const routed = routeChanged(
			model,
			{ search: { peek: trace(2).traceId, peekT: trace(2).startTime } },
			context,
		)
		expect(routed.model.peekDialog.isOpen).toBe(true)
		expect(routed.model.peek?.traceId).toBe(trace(2).traceId)
	})

	test("j steps the peek to the next loaded row; with no peek it moves the focus", () => {
		const model = loaded()
		const focused = pageUpdate(model, Message.PressedListKey({ key: "j" }))
		expect(focused.model.focusedIndex).toBe(0)
		const peeked = routeChanged(model, { search: { peek: trace(1).traceId } }, context).model
		expect(urlOf(pageUpdate(peeked, Message.PressedListKey({ key: "j" })))).toContain(trace(2).traceId)
	})

	test("dropping the peek params closes the sheet", () => {
		const peeked = routeChanged(loaded(), { search: { peek: trace(1).traceId } }, context).model
		const closed = routeChanged(peeked, { search: {} }, context).model
		expect(closed.peek).toBeNull()
		expect(closed.peekDialog.isOpen).toBe(false)
	})
})
