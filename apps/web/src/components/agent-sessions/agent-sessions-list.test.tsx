// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { cleanup, fireEvent, render, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sessionLinkWindow } from "@/lib/agent-sessions/session-window"
import { AgentSessionsList, type AgentSessionRow } from "./agent-sessions-list"

const navigate = vi.fn()

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
		<a {...(props as Record<string, string>)}>{children}</a>
	),
	useNavigate: () => navigate,
}))

// The table is virtualized against a scroll ancestor that jsdom gives zero
// height, so the real `useVirtualizer` yields no rows and nothing renders.
// Stub it to emit one row per session — that keeps the assertions on the
// component's actual row markup.
vi.mock("@tanstack/react-virtual", () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getVirtualItems: () =>
			Array.from({ length: count }, (_, index) => ({
				index,
				key: index,
				start: index * 53,
				end: (index + 1) * 53,
			})),
		getTotalSize: () => count * 53,
		measureElement: () => {},
		options: { scrollMargin: 0 },
	}),
}))

const session: AgentSessionRow = {
	sessionId: "wrun_01M0CSAEW96BH2W9185XZPRPKH",
	vendorId: "eve",
	traceCount: 2,
	spanCount: 12,
	errorSpanCount: 0,
	toolErrorCount: 0,
	turnErrorCount: 0,
	serviceNames: ["maple-slack-agent"],
	models: ["claude-sonnet-5"],
	agentNames: ["web-fetcher", "slack-agent"],
	firstAgentName: "slack-agent",
	llmCalls: 4,
	toolCalls: 2,
	totalTokens: 18_400,
	inputTokens: 12_000,
	cacheReadTokens: 4_000,
	cacheWriteTokens: 0,
	outputTokens: 2_000,
	reasoningTokens: 400,
	cost: 0.12,
	startTime: "2026-08-19 10:33:25.825000000",
	endTime: "2026-08-19 10:34:25.825000000",
	durationMs: 60_000,
}

const sort = { sortBy: "startTime", sortDir: "desc", onSortChange: () => {} } as const

class MockIntersectionObserver {
	static instances: MockIntersectionObserver[] = []
	readonly observe = vi.fn()
	readonly disconnect = vi.fn()

	constructor(readonly callback: IntersectionObserverCallback) {
		MockIntersectionObserver.instances.push(this)
	}
}

describe("AgentSessionsList", () => {
	beforeEach(() => {
		MockIntersectionObserver.instances = []
		vi.stubGlobal("IntersectionObserver", MockIntersectionObserver)
		navigate.mockReset()
	})

	afterEach(() => {
		cleanup()
		vi.unstubAllGlobals()
	})

	it("asks for the next page when the sentinel comes into view, but not while one is in flight", () => {
		const onReachEnd = vi.fn()
		const view = render(
			<AgentSessionsList {...sort} sessions={[session]} hasMore onReachEnd={onReachEnd} loadingMore={false} />,
		)

		const first = MockIntersectionObserver.instances[0]!
		expect(first.observe).toHaveBeenCalledOnce()
		first.callback([{ isIntersecting: true } as IntersectionObserverEntry], first as never)
		expect(onReachEnd).toHaveBeenCalledOnce()

		view.rerender(
			<AgentSessionsList {...sort} sessions={[session]} hasMore onReachEnd={onReachEnd} loadingMore />,
		)
		expect(first.disconnect).toHaveBeenCalledOnce()
		expect(view.getByText("Loading more sessions…")).toBeTruthy()

		const second = MockIntersectionObserver.instances[1]!
		second.callback([{ isIntersecting: true } as IntersectionObserverEntry], second as never)
		expect(onReachEnd).toHaveBeenCalledOnce()

		view.unmount()
		expect(second.disconnect).toHaveBeenCalledOnce()
	})

	it("renders no sentinel once the backend has no more pages", () => {
		render(<AgentSessionsList {...sort} sessions={[session]} hasMore={false} />)
		expect(MockIntersectionObserver.instances).toHaveLength(0)
	})

	it("names the framework by its mark alone, and splits the failures by kind", () => {
		const view = render(
			<AgentSessionsList
				{...sort}
				sessions={[
					{
						...session,
						errorSpanCount: 5,
						toolErrorCount: 2,
						turnErrorCount: 1,
					},
				]}
			/>,
		)
		// The agent names the row and the framework is the mark's label rather
		// than more text.
		expect(view.getByText("slack-agent")).toBeTruthy()
		expect(view.queryByText(/^eve/)).toBeNull()
		expect(view.getByRole("img", { name: "eve" })).toBeTruthy()
		// Two chips in two tones under the Errors header. The chip splits its
		// count and noun into fixed-width slots, so match on the whole chip's text.
		const chip = (label: string) => (_: string, element: Element | null) =>
			element?.classList.contains("rounded-full") === true && element.textContent === label
		expect(view.getAllByText(chip("2 tools"))).toHaveLength(1)
		expect(view.getAllByText(chip("1 turn"))).toHaveLength(1)
		expect(view.getByText("18.4k")).toBeTruthy()
		expect(view.getByText("maple-slack-agent")).toBeTruthy()
	})

	it("says a session without errors has none, rather than leaving the cell blank", () => {
		const view = render(<AgentSessionsList {...sort} sessions={[session]} />)
		const errors = view.getAllByRole("cell")[8]!
		expect(errors.textContent).toBe("—")
	})

	it("labels a framework's session key apart from a session that is one trace", () => {
		const view = render(
			<AgentSessionsList
				{...sort}
				sessions={[session, { ...session, sessionId: "trace:7f3a4b5c6d7e8f901234567890abcdef" }]}
			/>,
		)
		expect(view.getByText(session.sessionId).previousElementSibling?.textContent).toBe("Session")
		expect(view.getByText("7f3a4b5c6d7e…").previousElementSibling?.textContent).toBe("Trace")
	})

	it("sorts through the column headers, marking the one the rows are in", () => {
		const onSortChange = vi.fn()
		const view = render(
			<AgentSessionsList sessions={[session]} sortBy="cost" sortDir="desc" onSortChange={onSortChange} />,
		)
		const cost = view.getByRole("columnheader", { name: "Cost" })
		expect(cost.getAttribute("aria-sort")).toBe("descending")
		expect(view.getByRole("columnheader", { name: "Started" }).getAttribute("aria-sort")).toBeNull()

		fireEvent.click(within(cost).getByRole("button"))
		expect(onSortChange).toHaveBeenCalledWith("cost")
	})

	it("opens the session over its own window from the row, and only once from its link", () => {
		const view = render(<AgentSessionsList {...sort} sessions={[session]} />)

		fireEvent.click(view.getAllByRole("row")[1]!)
		expect(navigate).toHaveBeenCalledWith({
			to: "/agent-sessions/$sessionId",
			params: { sessionId: session.sessionId },
			search: sessionLinkWindow(session),
		})

		navigate.mockReset()
		fireEvent.click(view.getByText("slack-agent"))
		expect(navigate).not.toHaveBeenCalled()
	})

	it("explains the retention cap instead of paging further", () => {
		const view = render(<AgentSessionsList {...sort} sessions={[session]} isCapped />)
		expect(MockIntersectionObserver.instances).toHaveLength(0)
		expect(view.getByText(/Showing the 1 most recent sessions/)).toBeTruthy()
	})
})
