import { OrgId } from "@maple/domain"
import { AiSessionSpanCursor } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { sessionData } from "./derive"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const SESSION = "5f1c2a90-3b7e-4c1d-9a2f-7e0d4b6c8a11"

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const entered = (search: Model["search"] = {}) => init({ sessionId: SESSION, search }, context)

describe("agent session detail", () => {
	test("entering reads the first page and the clock", () => {
		const { model, commands } = entered()
		expect(names(commands)).toEqual(
			expect.arrayContaining(["FetchAgentSessionFirstPage", "ResolveAgentSessionClock"]),
		)
		expect(AsyncData.isLoading(model.firstPage.data)).toBe(true)
	})

	test("the clock read brings the browser locale the token titles format with", () => {
		const clocked = pageUpdate(
			entered().model,
			Message.CompletedResolveClock({ nowMs: 1, locale: "de-DE" }),
		)
		expect(clocked.model.locale).toBe("de-DE")
	})

	test("the tool a link carries seeds the span filter", () => {
		expect(entered({ tool: "Bash" }).model.query).toBe("Bash")
	})

	test("an empty first page is the not-found state and stamps nothing", () => {
		const { model } = entered()
		const key = model.firstPage.key ?? ""
		const landed = pageUpdate(
			model,
			Message.CompletedFetchFirstPage({ key, result: Result.succeed({ data: [], nextCursor: null }) }),
		)
		expect(landed.outMessage).toBeUndefined()
		expect(names(landed.commands)).toEqual([])
	})

	test("a dropped later page asks for nothing: each page is fetched once", () => {
		const { model } = entered()
		const key = model.firstPage.key ?? ""
		const cursor = (spanId: string) =>
			Schema.decodeSync(AiSessionSpanCursor)({ timestamp: "2026-10-01 12:00:00", spanId })
		const first = pageUpdate(
			model,
			Message.CompletedFetchFirstPage({
				key,
				result: Result.succeed({ data: [], nextCursor: cursor("s1") }),
			}),
		)
		expect(names(first.commands)).toEqual(["FetchAgentSessionMorePage"])
		const page = (at: number, next: string | null) =>
			Message.CompletedFetchMorePage({
				key,
				index: at,
				scope: "ai",
				isTooLarge: false,
				result: Result.succeed({ data: [], nextCursor: next === null ? null : cursor(next) }),
			})
		const stale = pageUpdate(
			first.model,
			Message.CompletedFetchMorePage({
				key: "old",
				index: 0,
				scope: "ai",
				isTooLarge: false,
				result: Result.succeed({ data: [], nextCursor: null }),
			}),
		)
		expect(names(stale.commands)).toEqual([])
		const second = pageUpdate(stale.model, page(0, "s2"))
		expect(names(second.commands)).toEqual(["FetchAgentSessionMorePage"])
		const duplicate = pageUpdate(second.model, page(0, "s2"))
		expect(names(duplicate.commands)).toEqual([])
		expect(duplicate.model.more.agentPages).toHaveLength(1)
	})

	test("a stale first page is dropped and asks for nothing", () => {
		const { model } = entered()
		const nextCursor = Schema.decodeSync(AiSessionSpanCursor)({
			timestamp: "2026-10-01 12:00:00",
			spanId: "s1",
		})
		const late = pageUpdate(
			model,
			Message.CompletedFetchFirstPage({ key: "old", result: Result.succeed({ data: [], nextCursor }) }),
		)
		expect(AsyncData.isLoading(late.model.firstPage.data)).toBe(true)
		expect(late.model.more).toEqual(model.more)
		expect(names(late.commands)).toEqual([])
	})

	test("the 2 key opens Traces as a step Back can undo", () => {
		expect(pageUpdate(entered().model, Message.PressedViewKey({ view: "trace" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/agent-sessions/${SESSION}?view=trace`,
				isReplace: false,
			}),
		)
	})

	test("opening a span pushes, moving to another replaces", () => {
		const opened = pageUpdate(entered().model, Message.ClickedSpan({ spanId: "a1" }))
		expect(opened.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/agent-sessions/${SESSION}?span=a1`,
				isReplace: false,
			}),
		)
		const moved = pageUpdate(entered({ span: "a1" }).model, Message.ClickedSpan({ spanId: "b2" }))
		expect(moved.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/agent-sessions/${SESSION}?span=b2`,
				isReplace: true,
			}),
		)
	})

	test("the body view switch flips only when the pressed segment changes", () => {
		const model = entered().model
		const raw = pageUpdate(model, Message.PressedBodyView({ key: "row:raw", isRaw: true })).model
		expect(raw.openRows).toEqual(["row:raw"])
		expect(
			pageUpdate(raw, Message.PressedBodyView({ key: "row:raw", isRaw: true })).model.openRows,
		).toEqual(["row:raw"])
		expect(
			pageUpdate(raw, Message.PressedBodyView({ key: "row:raw", isRaw: false })).model.openRows,
		).toEqual([])
	})

	test("display options and the ledger toggle in place", () => {
		const model = entered().model
		expect(
			pageUpdate(model, Message.ToggledOption({ option: "collapseIdle" })).model.options.collapseIdle,
		).toBe(false)
		const open = pageUpdate(model, Message.ToggledLedgerTool({ name: "Bash" })).model
		expect(open.ledgerOpen).toBe("Bash")
		expect(pageUpdate(open, Message.ToggledLedgerTool({ name: "Bash" })).model.ledgerOpen).toBeNull()
	})

	test("a measured clamp is recorded once", () => {
		const model = entered().model
		const clamped = pageUpdate(model, Message.MeasuredClamp({ key: "k", isClamped: true })).model
		expect(
			pageUpdate(clamped, Message.MeasuredClamp({ key: "k", isClamped: true })).model.clampedBodies,
		).toEqual(["k"])
	})

	test("the session's turns are built once per span change, not on every scroll tick", () => {
		const { model } = entered()
		const key = model.firstPage.key ?? ""
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchFirstPage({ key, result: Result.succeed({ data: [], nextCursor: null }) }),
		).model
		const window = { items: [{ index: 0, start: 0, end: 40 }], totalSize: 40, scrollMargin: 0 }
		const scrolled = pageUpdate(loaded, Message.ChangedTranscriptWindow({ window }))
		expect(scrolled.commands ?? []).toEqual([])
		expect(sessionData(scrolled.model)).toBe(sessionData(loaded))
		const reloaded = pageUpdate(
			scrolled.model,
			Message.CompletedFetchFirstPage({ key, result: Result.succeed({ data: [], nextCursor: null }) }),
		)
		expect(sessionData(reloaded.model)).not.toBe(sessionData(loaded))
	})
})
