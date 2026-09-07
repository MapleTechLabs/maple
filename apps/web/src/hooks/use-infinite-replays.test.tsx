// @vitest-environment jsdom
// TEST-SEAM: The pagination hook consumes a module-global runtime and route-backed atoms.
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Result } from "@/lib/effect-atom"
import { Schema, type Effect } from "effect"
import type { listReplays } from "@/api/warehouse/replays"
import { SessionId } from "@maple/domain/http"
type ReplaysPage = Effect.Success<ReturnType<typeof listReplays>>
import { useInfiniteReplays } from "./use-infinite-replays"

const mocks = vi.hoisted(() => ({
	runPromise: vi.fn(),
	firstPage: vi.fn(),
	logClientError: vi.fn(),
}))

vi.mock("@/lib/registry", () => ({ mapleRuntime: { runPromise: mocks.runPromise } }))
vi.mock("@/lib/services/common/telemetry", () => ({ logClientError: mocks.logClientError }))
vi.mock("@/api/warehouse/replays", () => ({ listReplays: (input: unknown) => input }))
vi.mock("@/lib/services/atoms/warehouse-query-atoms", () => ({
	listReplaysResultAtom: (input: unknown) => input,
}))
vi.mock("./use-refreshable-atom-value", () => ({ useRefreshableAtomValue: mocks.firstPage }))
const filters = { startTime: "2026-09-01 00:00:00", endTime: "2026-09-02 00:00:00" }
function page(body: string, cursor: string | null = "next"): ReplaysPage {
	return {
		data: [
			{
				sessionId: Schema.decodeSync(SessionId)(body),
				startTime: filters.startTime,
				endTime: null,
				durationMs: null,
				status: "active",
				userId: null,
				userName: "",
				userEmail: "",
				groupId: "",
				groupName: "",
				visitorId: "visitor",
				utmSource: "",
				entryPath: "/",
				urlInitial: "https://example.com",
				browserName: "Chrome",
				osName: "Linux",
				deviceType: "desktop",
				country: "DE",
				serviceName: "web",
				pageViews: 1,
				clickCount: 0,
				errorCount: 0,
				traceCount: 0,
				recorded: "",
			},
		],
		hasMore: cursor !== null,
		nextCursor: cursor,
	}
}

function pendingPage() {
	let resolve!: (value: ReplaysPage) => void
	const promise = new Promise<ReplaysPage>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

beforeEach(() => {
	vi.resetAllMocks()
	mocks.firstPage.mockReturnValue(Result.success(page("first")))
})

afterEach(cleanup)

describe("useInfiniteReplays", () => {
	it("stops automatic pagination after a failure and permits retry after refresh", async () => {
		const failure = new Error("cursor rejected")
		mocks.runPromise.mockRejectedValueOnce(failure)
		const { result, rerender } = renderHook(() => useInfiniteReplays(filters))

		await act(async () => result.current.fetchNextPage())
		expect(result.current.hasNextPage).toBe(false)
		expect(result.current.isFetchingNextPage).toBe(false)
		expect(result.current.allData.map((log) => log.sessionId)).toEqual(["first"])
		expect(mocks.logClientError).toHaveBeenCalledWith("replay.pagination_failed", failure)

		await act(async () => result.current.fetchNextPage())
		expect(mocks.runPromise).toHaveBeenCalledTimes(1)

		mocks.firstPage.mockReturnValue(Result.success(page("refreshed", "fresh-cursor")))
		rerender()
		mocks.runPromise.mockResolvedValueOnce(page("next page", null))
		await act(async () => result.current.fetchNextPage())
		expect(mocks.runPromise).toHaveBeenLastCalledWith({
			data: expect.objectContaining({ cursor: "fresh-cursor" }),
		})
		expect(result.current.allData.map((log) => log.sessionId)).toEqual(["refreshed", "next page"])
	})

	it("discards accumulated pages when the first page is refreshed", async () => {
		mocks.runPromise.mockResolvedValueOnce(page("old second page"))
		const { result, rerender } = renderHook(() => useInfiniteReplays(filters))
		await act(async () => result.current.fetchNextPage())
		expect(result.current.allData).toHaveLength(2)

		mocks.firstPage.mockReturnValue(Result.success(page("refreshed")))
		rerender()
		expect(result.current.allData.map((log) => log.sessionId)).toEqual(["refreshed"])
	})

	it("does not let an older request clear the current request's guard", async () => {
		const oldRequest = pendingPage()
		const newRequest = pendingPage()
		mocks.runPromise.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)
		const { result, rerender } = renderHook(({ search }) => useInfiniteReplays({ ...filters, search }), {
			initialProps: { search: "old" },
		})
		act(() => result.current.fetchNextPage())
		rerender({ search: "new" })
		act(() => result.current.fetchNextPage())

		await act(async () => oldRequest.resolve(page("stale")))
		expect(result.current.isFetchingNextPage).toBe(true)
		act(() => result.current.fetchNextPage())
		expect(mocks.runPromise).toHaveBeenCalledTimes(2)

		await act(async () => newRequest.resolve(page("current", null)))
		expect(result.current.allData.map((log) => log.sessionId)).toEqual(["first", "current"])
		expect(result.current.isFetchingNextPage).toBe(false)
	})

	it("ignores a stale page after leaving and returning to the same filter", async () => {
		const oldRequest = pendingPage()
		mocks.runPromise.mockReturnValueOnce(oldRequest.promise)
		const { result, rerender } = renderHook(({ search }) => useInfiniteReplays({ ...filters, search }), {
			initialProps: { search: "a" },
		})
		act(() => result.current.fetchNextPage())
		rerender({ search: "b" })
		rerender({ search: "a" })

		await act(async () => oldRequest.resolve(page("stale")))
		expect(result.current.allData.map((log) => log.sessionId)).toEqual(["first"])
	})

	it("waits for the current first page instead of fetching with a retained cursor", () => {
		mocks.firstPage.mockReturnValue(Result.success(page("retained"), { waiting: true }))
		const { result } = renderHook(() => useInfiniteReplays(filters))
		act(() => result.current.fetchNextPage())
		expect(mocks.runPromise).not.toHaveBeenCalled()
	})

	it("uses the server cursor even for a short page, and stops at has_more=false", async () => {
		mocks.runPromise.mockResolvedValueOnce(page("second", null))
		const { result } = renderHook(() => useInfiniteReplays({ ...filters, visitorId: "visitor" }))
		expect(result.current.hasNextPage).toBe(true)
		await act(async () => result.current.fetchNextPage())
		expect(mocks.runPromise).toHaveBeenCalledWith({
			data: { ...filters, visitorId: "visitor", limit: 50, cursor: "next" },
		})
		expect(result.current.hasNextPage).toBe(false)
	})

	it("stops when the server repeats a cursor", async () => {
		mocks.runPromise.mockResolvedValueOnce(page("second", "next"))
		const { result } = renderHook(() => useInfiniteReplays(filters))
		await act(async () => result.current.fetchNextPage())
		expect(result.current.hasNextPage).toBe(false)
	})
})
