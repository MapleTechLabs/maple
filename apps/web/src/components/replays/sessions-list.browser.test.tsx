// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionsList, type SessionRow } from "./sessions-list"

// Link is only imported for the empty state's setup CTA, which these tests never render.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: () => null }))

const session: SessionRow = {
	sessionId: "session-1",
	startTime: "2026-07-17 12:00:00",
	durationMs: 1000,
	status: "ended",
	lastActivityAt: "2026-07-17 12:00:01",
	userId: null,
	userName: "",
	userEmail: "",
	groupId: "",
	groupName: "",
	urlInitial: "https://example.com",
	browserName: "Chrome",
	osName: "macOS",
	deviceType: "desktop",
	country: "DE",
	serviceName: "web",
	pageViews: 1,
	clickCount: 1,
	errorCount: 0,
	traceCount: 1,
	recorded: "true",
	tags: ["engaged"],
}

class MockIntersectionObserver {
	static instances: MockIntersectionObserver[] = []
	readonly observe = vi.fn()
	readonly disconnect = vi.fn()

	constructor(readonly callback: IntersectionObserverCallback) {
		MockIntersectionObserver.instances.push(this)
	}
}

describe("SessionsList pagination observer", () => {
	beforeEach(() => {
		MockIntersectionObserver.instances = []
		vi.stubGlobal("IntersectionObserver", MockIntersectionObserver)
	})

	afterEach(() => {
		cleanup()
		vi.unstubAllGlobals()
	})

	it("disconnects and replaces the observer when pagination state changes", () => {
		const onReachEnd = vi.fn()
		const view = render(
			<SessionsList sessions={[session]} hasMore onReachEnd={onReachEnd} loadingMore={false} />,
		)

		const first = MockIntersectionObserver.instances[0]!
		expect(first.observe).toHaveBeenCalledOnce()
		first.callback([{ isIntersecting: true } as IntersectionObserverEntry], first as never)
		expect(onReachEnd).toHaveBeenCalledOnce()

		view.rerender(<SessionsList sessions={[session]} hasMore onReachEnd={onReachEnd} loadingMore />)
		expect(first.disconnect).toHaveBeenCalledOnce()

		const second = MockIntersectionObserver.instances[1]!
		second.callback([{ isIntersecting: true } as IntersectionObserverEntry], second as never)
		expect(onReachEnd).toHaveBeenCalledOnce()

		view.unmount()
		expect(second.disconnect).toHaveBeenCalledOnce()
	})

	const bots = (count: number): SessionRow[] =>
		Array.from({ length: count }, (_, index) => ({
			...session,
			sessionId: `bot-${index}`,
			tags: ["bot"],
			traceCount: 0,
		}))
	const onReachEnd = vi.fn()
	const list = (sessions: SessionRow[]) => (
		<SessionsList sessions={sessions} collapseLowSignal hasMore onReachEnd={onReachEnd} />
	)

	// A page that only extends a folded run leaves the sentinel where it was, so
	// it would pull every remaining page without the user scrolling.
	it("pauses after pages that add no row and resumes on scroll", () => {
		const view = render(list([session, ...bots(2)]))
		const first = MockIntersectionObserver.instances[0]!

		view.rerender(list([session, ...bots(4)]))
		view.rerender(list([session, ...bots(6)]))
		expect(first.disconnect).not.toHaveBeenCalled()

		view.rerender(list([session, ...bots(8)]))
		expect(first.disconnect).toHaveBeenCalledOnce()
		expect(MockIntersectionObserver.instances).toHaveLength(1)
		expect(view.queryByRole("button", { name: /load more/i })).toBeNull()

		fireEvent.scroll(window)
		expect(MockIntersectionObserver.instances).toHaveLength(2)
	})

	it("keeps auto-loading while pages add rows", () => {
		const engaged = (count: number) =>
			Array.from({ length: count }, (_, index) => ({ ...session, sessionId: `s-${index}` }))
		const view = render(list([...bots(2), ...engaged(1)]))
		for (const count of [2, 3, 4, 5]) view.rerender(list([...bots(2), ...engaged(count)]))

		expect(MockIntersectionObserver.instances).toHaveLength(1)
		expect(MockIntersectionObserver.instances[0]!.disconnect).not.toHaveBeenCalled()
	})
})

// The list is virtualized against a scroll ancestor that jsdom gives zero
// height, so the real `useVirtualizer` yields no rows and nothing renders.
// Stub it to emit one row per session — that keeps the assertions on the
// component's actual row markup rather than an extracted helper.
vi.mock("@tanstack/react-virtual", () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getVirtualItems: () =>
			Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 78 })),
		getTotalSize: () => count * 78,
		measureElement: () => {},
		options: { scrollMargin: 0 },
	}),
}))

describe("SessionsList recording badge", () => {
	afterEach(cleanup)

	it("flags a session the SDK marked as unrecorded", () => {
		const view = render(<SessionsList sessions={[{ ...session, recorded: "false" }]} />)
		// Rendered twice — the row carries a narrow-column badge strip and a wide
		// one, with CSS container queries picking which is visible.
		expect(view.getAllByText("Transcript only")).toHaveLength(2)
	})

	it("stays silent for a recorded session", () => {
		const view = render(<SessionsList sessions={[session]} />)
		expect(view.queryAllByText("Transcript only")).toHaveLength(0)
	})

	// Sessions written before the SDK stamped the marker read `""`. That is
	// "unknown", not "not recorded" — badging them would be a guess.
	it("stays silent when the marker is absent", () => {
		const view = render(<SessionsList sessions={[{ ...session, recorded: "" }]} />)
		expect(view.queryAllByText("Transcript only")).toHaveLength(0)
	})
})

// The browser SDK's identify() fills UserName / UserEmail / GroupId / GroupName.
// Sessions recorded before it existed carry "" in all four and must keep the
// original rendering — an opaque id over a mono entry-url line.
describe("SessionsList identity", () => {
	afterEach(cleanup)

	const identified = {
		...session,
		userId: "user_42",
		userName: "Ada Lovelace",
		userEmail: "ada@acme.com",
		groupId: "acme",
		groupName: "Acme Inc",
	}

	it("prefers the name over the raw user id", () => {
		const view = render(<SessionsList sessions={[identified]} />)
		expect(view.getByText("Ada Lovelace")).toBeTruthy()
		expect(view.queryByText("user_42")).toBeNull()
	})

	it("puts the email under the name and the org in its own column", () => {
		const view = render(<SessionsList sessions={[identified]} />)
		const line = view.getByText("ada@acme.com")
		// Prose, not the mono entry-url line it replaces.
		expect(line.className).not.toContain("font-mono")
		expect(line.getAttribute("title")).toBe("example.com")
		// Two copies: the stacked narrow row and the wide Org column.
		expect(view.getAllByText("Acme Inc")).toHaveLength(2)
	})

	it("filters by org and tag from the row without opening it", () => {
		const onFilterGroup = vi.fn()
		const onFilterTag = vi.fn()
		const view = render(
			<SessionsList sessions={[identified]} onFilterGroup={onFilterGroup} onFilterTag={onFilterTag} />,
		)
		fireEvent.click(view.getAllByRole("button", { name: "Acme Inc" })[0]!)
		expect(onFilterGroup).toHaveBeenCalledWith("Acme Inc")
		fireEvent.click(view.getAllByRole("button", { name: "Engaged" })[0]!)
		expect(onFilterTag).toHaveBeenCalledWith("engaged")
	})

	it("falls back to the email when there is no name", () => {
		const view = render(<SessionsList sessions={[{ ...identified, userName: "" }]} />)
		// Label only: the line beneath falls back to the entry page, not the email again.
		expect(view.getAllByText("ada@acme.com")).toHaveLength(1)
		expect(view.getByText("example.com")).toBeTruthy()
	})

	it("renders a pre-identify session exactly as before", () => {
		const view = render(<SessionsList sessions={[{ ...session, userId: "user_42" }]} />)
		expect(view.getByText("user_42")).toBeTruthy()
		const line = view.getByText("example.com")
		expect(line.className).toContain("font-mono")
	})

	it("still says Anonymous when nothing identifies the session", () => {
		const view = render(<SessionsList sessions={[session]} />)
		expect(view.getByText("Anonymous")).toBeTruthy()
	})
})

// The LIVE pill is the one thing on this list whose truth expires without any
// new data: nothing refetches on an idle `/replays`, so if "now" is only read
// during render the pill outlives its window until something unrelated
// repaints the row.
describe("SessionsList live pill expiry", () => {
	beforeEach(() => vi.useFakeTimers())

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	const startedAt = "2026-07-17 12:00:00"
	const active: SessionRow = {
		...session,
		status: "active",
		startTime: startedAt,
		lastActivityAt: startedAt,
		durationMs: null,
	}

	it("drops the pill once the live window closes, with no prop change", async () => {
		vi.setSystemTime(new Date(`${startedAt.replace(" ", "T")}Z`))
		const view = render(<SessionsList sessions={[active]} />)
		expect(view.queryAllByText("LIVE").length).toBeGreaterThan(0)

		// Past the 300s window, and past the clock's own tick so a re-render is
		// actually scheduled.
		await vi.advanceTimersByTimeAsync(400_000)
		expect(view.queryAllByText("LIVE")).toHaveLength(0)
	})

	it("keeps the pill while the heartbeat is still inside the window", async () => {
		vi.setSystemTime(new Date(`${startedAt.replace(" ", "T")}Z`))
		const view = render(<SessionsList sessions={[active]} />)

		await vi.advanceTimersByTimeAsync(120_000)
		expect(view.queryAllByText("LIVE").length).toBeGreaterThan(0)
	})

	// An explicit `nowMs` is the test seam the other suites rely on; the ticking
	// clock must not override it.
	it("honours an injected nowMs instead of the wall clock", async () => {
		vi.setSystemTime(new Date("2030-01-01T00:00:00Z"))
		const view = render(
			<SessionsList sessions={[active]} nowMs={Date.parse(`${startedAt.replace(" ", "T")}Z`)} />,
		)
		await vi.advanceTimersByTimeAsync(400_000)
		expect(view.queryAllByText("LIVE").length).toBeGreaterThan(0)
	})
})

// Bots, bounces, idle tabs and glances are most of a typical window. Adjacent ones
// fold into one row so the sessions worth watching sit close together.
describe("SessionsList low-signal runs", () => {
	afterEach(cleanup)

	const bot = (id: string): SessionRow => ({ ...session, sessionId: id, tags: ["bot"], traceCount: 0 })
	const sessions = [session, bot("bot-1"), bot("bot-2"), { ...session, sessionId: "session-2" }]

	it("folds a run into one expandable row", () => {
		const view = render(<SessionsList sessions={sessions} collapseLowSignal />)
		const run = view.getByText("2 low-signal sessions").closest("button")!
		expect(run.getAttribute("aria-expanded")).toBe("false")
		expect(view.queryAllByText("Bot")).toHaveLength(0)

		fireEvent.click(run)
		expect(run.getAttribute("aria-expanded")).toBe("true")
		// Each row renders its tags twice: stacked (narrow) and in the Tags column.
		expect(view.getAllByText("Bot")).toHaveLength(4)
	})

	it("shows every row when collapsing is off", () => {
		const view = render(<SessionsList sessions={sessions} />)
		expect(view.queryByText("2 low-signal sessions")).toBeNull()
		expect(view.getAllByText("Bot")).toHaveLength(4)
	})
})
