// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AiSessionTooLargeError, type AiSessionSpan } from "@maple/domain/http"
import type { AiSessionSpansPage } from "@/api/warehouse/ai-sessions"
import { Atom, Result } from "@/lib/effect-atom"
import type { QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
import { agentSpan, llmSpan, makeSpan } from "@/lib/agent-sessions/span-test-support"

import { useSessionSpans, type SessionSpansReads } from "./use-session-spans"

const mocks = {
	firstPage: { data: [] as readonly AiSessionSpan[], nextCursor: undefined as { timestamp: string; spanId: string } | undefined },
}
/** Every page past the first goes through the injected fetcher. */
const fetchPage = vi.fn<SessionSpansReads["fetchPage"]>()
/** One atom per distinct input, the way the real family behaves. */
type FirstPageAtom = Atom.Atom<Result.Result<AiSessionSpansPage, QueryAtomFailure>>
const atoms = new Map<string, FirstPageAtom>()
const reads: SessionSpansReads = {
	firstPageAtom: (input) => {
		const key = JSON.stringify(input)
		let atom = atoms.get(key)
		if (atom === undefined) {
			atom = Atom.make(Result.success<AiSessionSpansPage, QueryAtomFailure>(mocks.firstPage))
			atoms.set(key, atom)
		}
		return atom
	},
	fetchPage,
}

const SECOND = 1000
const CURSOR = { timestamp: "2026-08-19 10:00:30.000000000", spanId: "llm-1" }

const firstPageSpans = [
	agentSpan({ spanId: "agent-1", startMs: 0, durationMs: 30 * SECOND }),
	llmSpan({ spanId: "llm-1", parentSpanId: "agent-1", startMs: SECOND, durationMs: 5 * SECOND }),
	makeSpan({ spanId: "http-1", parentSpanId: "agent-1", startMs: 2 * SECOND, durationMs: 100, spanName: "GET /x", isAiSpan: false }),
]
const secondPageSpans = [
	agentSpan({ spanId: "agent-2", startMs: 60 * SECOND, durationMs: 30 * SECOND }),
	llmSpan({ spanId: "llm-2", parentSpanId: "agent-2", startMs: 61 * SECOND, durationMs: 5 * SECOND }),
]

afterEach(() => {
	fetchPage.mockReset()
	atoms.clear()
	mocks.firstPage = { data: [], nextCursor: undefined }
})

describe("useSessionSpans", () => {
	it("is complete after one page when the session fits", () => {
		mocks.firstPage = { data: firstPageSpans, nextCursor: undefined }
		const { result } = renderHook(() => useSessionSpans("s1", undefined, reads))

		expect(result.current.progress).toBeUndefined()
		expect(result.current.spans.map((span) => span.spanId)).toEqual(["agent-1", "llm-1", "http-1"])
		expect(fetchPage).not.toHaveBeenCalled()
	})

	// Nothing is asked of the reader: the agent's pages drain first, then the
	// app's, both continuing from the first page's cursor.
	it("drains the agent's pages and then the app's on its own, after the first page's cursor", async () => {
		mocks.firstPage = { data: firstPageSpans, nextCursor: CURSOR }
		const appSpan = makeSpan({ spanId: "http-2", parentSpanId: "agent-2", startMs: 62 * SECOND, durationMs: 100, spanName: "GET /y", isAiSpan: false })
		const AI_CURSOR = { timestamp: "2026-08-19 10:01:00.000000000", spanId: "llm-2" }
		fetchPage
			.mockResolvedValueOnce({ data: secondPageSpans, nextCursor: AI_CURSOR })
			.mockResolvedValueOnce({ data: [agentSpan({ spanId: "agent-3", startMs: 120 * SECOND, durationMs: SECOND })], nextCursor: undefined })
			.mockResolvedValueOnce({ data: [appSpan], nextCursor: undefined })
		const window = { startTime: "2026-08-19 09:00:00", endTime: "2026-08-19 11:00:00" }
		const { result } = renderHook(() => useSessionSpans("s1", window, reads))

		expect(result.current.progress?.phase).toBe("agent")
		await waitFor(() => expect(result.current.progress?.phase).toBe("complete"))

		expect(fetchPage.mock.calls.map((call) => call[0])).toEqual([
			{ sessionId: "s1", ...window, scope: "ai", after: CURSOR, limit: 2000 },
			{ sessionId: "s1", ...window, scope: "ai", after: AI_CURSOR, limit: 2000 },
			{ sessionId: "s1", ...window, scope: "app", after: CURSOR, limit: 2000 },
		])
		expect(result.current.spans.map((span) => span.spanId)).toEqual([
			"agent-1", "llm-1", "http-1", "agent-2", "llm-2", "agent-3", "http-2",
		])
		expect(result.current.progress).toMatchObject({ loadedSpans: 7, loadedAgentSpans: 5 })
	})

	it("reports the app phase once every agent span is in", async () => {
		mocks.firstPage = { data: firstPageSpans, nextCursor: CURSOR }
		let resolveApp: (page: AiSessionSpansPage) => void = () => undefined
		fetchPage
			.mockResolvedValueOnce({ data: secondPageSpans, nextCursor: undefined })
			.mockImplementationOnce(() => new Promise((resolve) => { resolveApp = resolve }))
		const { result } = renderHook(() => useSessionSpans("s1", undefined, reads))

		await waitFor(() => expect(result.current.progress?.phase).toBe("app"))
		expect(result.current.spans).toHaveLength(5)
		await act(async () => resolveApp({ data: [], nextCursor: undefined }))
		expect(result.current.progress?.phase).toBe("complete")
	})

	// A 413 is the byte cap, not the row cap: the same read with fewer rows.
	it("halves the page when the byte cap ends one, and keeps going", async () => {
		mocks.firstPage = { data: firstPageSpans, nextCursor: CURSOR }
		fetchPage
			.mockRejectedValueOnce(new AiSessionTooLargeError({ sessionId: "s1", message: "too large" }))
			.mockResolvedValueOnce({ data: secondPageSpans, nextCursor: undefined })
			.mockResolvedValueOnce({ data: [], nextCursor: undefined })
		const { result } = renderHook(() => useSessionSpans("s1", undefined, reads))

		await waitFor(() => expect(result.current.progress?.phase).toBe("complete"))
		expect(fetchPage.mock.calls[0]![0].limit).toBe(2000)
		expect(fetchPage.mock.calls[1]![0].limit).toBe(1000)
		expect(result.current.spans).toHaveLength(5)
	})

	it("keeps what loaded when a page fails, and resumes from there on retry", async () => {
		mocks.firstPage = { data: firstPageSpans, nextCursor: CURSOR }
		const AI_CURSOR = { timestamp: "2026-08-19 10:01:00.000000000", spanId: "llm-2" }
		fetchPage
			.mockResolvedValueOnce({ data: secondPageSpans, nextCursor: AI_CURSOR })
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce({ data: [agentSpan({ spanId: "agent-3", startMs: 120 * SECOND, durationMs: SECOND })], nextCursor: undefined })
			.mockResolvedValueOnce({ data: [], nextCursor: undefined })
		const { result } = renderHook(() => useSessionSpans("s1", undefined, reads))

		await waitFor(() => expect(result.current.progress?.phase).toBe("failed"))
		expect(result.current.spans).toHaveLength(5)

		act(() => result.current.progress?.retry())
		await waitFor(() => expect(result.current.progress?.phase).toBe("complete"))
		// Resumed after the last page that landed, not from the start.
		expect(fetchPage.mock.calls[2]![0]).toMatchObject({ scope: "ai", after: AI_CURSOR })
		expect(result.current.spans.map((span) => span.spanId)).toContain("agent-3")
	})

	it("drops the pages of a read the window moved on from, and a response landing late", async () => {
		mocks.firstPage = { data: firstPageSpans, nextCursor: CURSOR }
		let resolveLate: (page: AiSessionSpansPage) => void = () => undefined
		fetchPage
			.mockResolvedValueOnce({ data: secondPageSpans, nextCursor: CURSOR })
			.mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve }))
			// The new window's own drain.
			.mockImplementation(() => new Promise(() => undefined))
		const early = { startTime: "2026-08-19 09:00:00", endTime: "2026-08-19 11:00:00" }
		const { result, rerender } = renderHook(({ window }) => useSessionSpans("s1", window, reads), {
			initialProps: { window: early },
		})

		await waitFor(() => expect(result.current.spans).toHaveLength(5))
		// A second page is in flight when the window changes.
		rerender({ window: { startTime: "2026-08-19 08:00:00", endTime: "2026-08-19 12:00:00" } })

		expect(result.current.spans).toHaveLength(3)
		expect(result.current.progress?.phase).toBe("agent")
		await act(async () => {
			resolveLate({ data: [agentSpan({ spanId: "late", startMs: 0, durationMs: SECOND })], nextCursor: undefined })
		})
		expect(result.current.spans.map((span) => span.spanId)).not.toContain("late")
		expect(result.current.spans).toHaveLength(3)
	})
})
