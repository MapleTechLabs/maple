// @vitest-environment jsdom
// TEST-SEAM: The pagination hook consumes a module-global runtime and route-backed atoms.
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Result } from "@/lib/effect-atom"
import type { AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"
import { AI_SESSIONS_LIVE_POLL_MS, useInfiniteAiSessions } from "./use-infinite-ai-sessions"

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	firstPage: vi.fn(),
	logClientError: vi.fn(),
}))

// Details never land here: the rows keep the index's figures, which is all these tests read.
vi.mock("@/lib/registry", () => ({
	mapleRuntime: {
		runPromise: (effect: { list?: unknown }) =>
			effect.list === undefined ? new Promise(() => {}) : mocks.list(effect.list),
	},
}))
vi.mock("@/lib/services/common/telemetry", () => ({ logClientError: mocks.logClientError }))
vi.mock("@/api/warehouse/ai-sessions", () => ({
	listAiSessions: (input: { data: unknown }) => ({ list: input.data }),
	getAiSessionDetails: (input: { data: unknown }) => ({ details: input.data }),
}))
vi.mock("@/lib/services/atoms/warehouse-query-atoms", () => ({
	listAiSessionsResultAtom: (input: unknown) => input,
}))
vi.mock("./use-refreshable-atom-value", () => ({ useRefreshableAtomValue: mocks.firstPage }))

const filters = { startTime: "2026-09-04 12:00:00", endTime: "2026-09-11 12:00:00" }
const NOW = "2026-09-11T12:10:00Z"

function row(sessionId: string, startTime = "2026-09-11 11:00:00.000000000"): AgentSessionRow {
	return {
		sessionId,
		vendorId: "eve",
		traceCount: 1,
		spanCount: 1,
		errorSpanCount: 0,
		toolErrorCount: 0,
		turnErrorCount: 0,
		serviceNames: [],
		models: [],
		agentNames: [],
		firstAgentName: "",
		llmCalls: 0,
		toolCalls: 0,
		totalTokens: 0,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		cost: 0,
		startTime,
		endTime: startTime,
		durationMs: 0,
	}
}

const ids = (rows: ReadonlyArray<AgentSessionRow>) => rows.map((r) => r.sessionId)
const tick = () => act(async () => vi.advanceTimersByTime(AI_SESSIONS_LIVE_POLL_MS))

let visibility: DocumentVisibilityState = "visible"

beforeEach(() => {
	vi.resetAllMocks()
	vi.useFakeTimers({ now: new Date(NOW) })
	visibility = "visible"
	vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
	mocks.firstPage.mockReturnValue(Result.success({ data: [row("listed")] }))
	mocks.list.mockResolvedValue({ data: [] })
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe("useInfiniteAiSessions live poll", () => {
	it("prepends sessions that started after the list's window, and only those", async () => {
		mocks.list.mockResolvedValueOnce({
			data: [
				row("new", "2026-09-11 12:05:00.000000000"),
				// Active before the list's end: its figures would be the poll window's slice.
				row("running", "2026-09-11 11:30:00.000000000"),
				row("listed", "2026-09-11 12:01:00.000000000"),
			],
		})
		const { result } = renderHook(() => useInfiniteAiSessions({ ...filters, search: "abc" }))

		await tick()
		expect(mocks.list).toHaveBeenCalledWith({
			...filters,
			search: "abc",
			startTime: "2026-09-11 11:00:00",
			endTime: "2026-09-11 12:10:05",
			limit: 50,
			offset: 0,
		})
		expect(ids(result.current.allData)).toEqual(["new", "listed"])

		mocks.list.mockResolvedValueOnce({
			data: [row("newer", "2026-09-11 12:09:00.000000000"), row("new", "2026-09-11 12:05:00.000000000")],
		})
		await tick()
		expect(ids(result.current.allData)).toEqual(["newer", "new", "listed"])
	})

	it("pages past the ranked rows only, and drops a live copy a page also holds", async () => {
		const firstPage = Array.from({ length: 50 }, (_, i) => row(`page-${i}`))
		mocks.firstPage.mockReturnValue(Result.success({ data: firstPage }))
		mocks.list.mockResolvedValueOnce({ data: [row("new", "2026-09-11 12:05:00.000000000")] })
		const { result } = renderHook(() => useInfiniteAiSessions(filters))
		await tick()
		expect(result.current.allData).toHaveLength(51)

		mocks.list.mockResolvedValueOnce({ data: [row("new")] })
		await act(async () => result.current.fetchNextPage())
		expect(mocks.list).toHaveBeenLastCalledWith({ ...filters, limit: 50, offset: 50 })
		expect(ids(result.current.allData).filter((id) => id === "new")).toEqual(["new"])
		expect(ids(result.current.allData).at(-1)).toBe("new")
	})

	it("skips ticks while hidden or in flight, and polls as the tab becomes visible", async () => {
		visibility = "hidden"
		renderHook(() => useInfiniteAiSessions(filters))
		await tick()
		expect(mocks.list).not.toHaveBeenCalled()

		let settle!: (page: { data: [] }) => void
		mocks.list.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
		visibility = "visible"
		act(() => void document.dispatchEvent(new Event("visibilitychange")))
		expect(mocks.list).toHaveBeenCalledTimes(1)

		await tick()
		expect(mocks.list).toHaveBeenCalledTimes(1)

		await act(async () => settle({ data: [] }))
		await tick()
		expect(mocks.list).toHaveBeenCalledTimes(2)
	})

	it("does not poll under another sort or while the first page is waiting", async () => {
		const { rerender } = renderHook(({ sortBy }) => useInfiniteAiSessions({ ...filters, sortBy }), {
			initialProps: { sortBy: "cost" as "cost" | undefined },
		})
		await tick()
		mocks.firstPage.mockReturnValue(Result.success({ data: [row("listed")] }, { waiting: true }))
		rerender({ sortBy: undefined })
		await tick()
		expect(mocks.list).not.toHaveBeenCalled()
	})

	it("logs a failed poll and asks again on the next tick", async () => {
		const failure = new Error("warehouse down")
		mocks.list.mockRejectedValueOnce(failure)
		const { result } = renderHook(() => useInfiniteAiSessions(filters))
		await tick()
		expect(mocks.logClientError).toHaveBeenCalledWith("ai_session.live_poll_failed", failure)
		expect(ids(result.current.allData)).toEqual(["listed"])

		await tick()
		expect(mocks.list).toHaveBeenCalledTimes(2)
	})

	it("drops the live sessions when the filters change", async () => {
		mocks.list.mockResolvedValueOnce({ data: [row("new", "2026-09-11 12:05:00.000000000")] })
		const { result, rerender } = renderHook(({ search }) => useInfiniteAiSessions({ ...filters, search }), {
			initialProps: { search: "a" as string | undefined },
		})
		await tick()
		expect(ids(result.current.allData)).toEqual(["new", "listed"])

		rerender({ search: undefined })
		expect(ids(result.current.allData)).toEqual(["listed"])
	})
})
