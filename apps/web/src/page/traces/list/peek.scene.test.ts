import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import { MountPeekRows } from "./command"
import { view as pageView } from "./view"
import { VirtualizeTraces } from "./virtualize"
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
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load", timeZone: "UTC" }),
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
		const focused = pageUpdate(model, Message.PressedListKey({ key: "j", isMobile: false }))
		expect(focused.model.focusedIndex).toBe(0)
		const peeked = routeChanged(model, { search: { peek: trace(1).traceId } }, context).model
		expect(urlOf(pageUpdate(peeked, Message.PressedListKey({ key: "j", isMobile: false })))).toContain(
			trace(2).traceId,
		)
	})

	test("dropping the peek params closes the sheet", () => {
		const peeked = routeChanged(loaded(), { search: { peek: trace(1).traceId } }, context).model
		const closed = routeChanged(peeked, { search: {} }, context).model
		expect(closed.peek).toBeNull()
		expect(closed.peekDialog.isOpen).toBe(false)
	})

	const replaceOf = (result: { readonly outMessage?: unknown }) =>
		typeof result.outMessage === "object" &&
		result.outMessage !== null &&
		"isReplace" in result.outMessage
			? result.outMessage.isReplace
			: undefined

	test("stepping and closing the peek replace history; opening one pushes", () => {
		const model = loaded()
		expect(replaceOf(pageUpdate(model, Message.ClickedPeekRow({ index: 0 })))).toBe(false)
		const peeked = routeChanged(model, { search: { peek: trace(1).traceId } }, context).model
		expect(replaceOf(pageUpdate(peeked, Message.ClickedPeekStep({ step: 1 })))).toBe(true)
		const closed = pageUpdate(
			peeked,
			Message.GotPeekDialogMessage({ message: Dialog.Message.ClickedClose() }),
		)
		expect(urlOf(closed)).toBe("/traces")
		expect(replaceOf(closed)).toBe(true)
	})

	test("a peekRow that is not loaded falls back to the trace's first row", () => {
		const peeked = routeChanged(
			loaded(),
			{ search: { peek: trace(2).traceId, peekRow: "gone", peekT: "2026-09-30 00:00:00" } },
			context,
		).model
		expect(peeked.peek?.search.t).toBe(trace(2).startTime)
		expect(urlOf(pageUpdate(peeked, Message.ClickedPeekStep({ step: 1 })))).toContain(trace(3).traceId)
	})

	test("below md Enter opens the trace page and j moves the focus, even with a peek in the URL", () => {
		const peeked = routeChanged(loaded(), { search: { peek: trace(1).traceId } }, context).model
		const focused = pageUpdate(peeked, Message.PressedListKey({ key: "j", isMobile: true }))
		expect(focused.outMessage).toBeUndefined()
		expect(focused.model.focusedIndex).toBe(0)
		const opened = pageUpdate(focused.model, Message.PressedListKey({ key: "Enter", isMobile: true }))
		expect(urlOf(opened)).toMatch(new RegExp(`^/traces/${trace(1).traceId}\\?`))
		expect(urlOf(pageUpdate(loaded(), Message.PressedOpenRow({ index: 2 })))).toContain(
			`/traces/${trace(3).traceId}`,
		)
	})

	test("below md the URL's peek draws no sheet", () => {
		const peeked = routeChanged(loaded(), { search: { peek: trace(1).traceId } }, context).model
		scene(
			{ update: pageUpdate, view: withViewInputs(pageView, { context, isMobile: true })() },
			given(peeked),
			Mount.resolve(VirtualizeTraces, Message.ChangedVirtualWindow({ rows: [], totalSize: 0 })),
			Mount.resolve(MountPeekRows, Message.ClickedPeekRow({ index: 99 })),
			expectView(role("link", { name: "Open trace" })).toBeAbsent(),
		)
	})
})
