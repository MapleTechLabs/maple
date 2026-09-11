// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const windows = {
	list: [] as Array<{ startTime?: string; endTime?: string }>,
	facets: [] as Array<{ startTime: string; endTime: string }>,
}

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")
	return { ...actual, useNavigate: () => vi.fn() }
})

vi.mock("@/components/layout/dashboard-layout", () => {
	const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
	return {
		DashboardLayout: {
			Root: passthrough,
			Breadcrumbs: () => null,
			Body: passthrough,
			Filters: passthrough,
			Content: passthrough,
			Sticky: passthrough,
			Scroll: passthrough,
		},
	}
})

vi.mock("@/components/agent-sessions/agent-sessions-list", () => ({
	AgentSessionsList: () => null,
	AgentSessionsListSkeleton: () => null,
}))
vi.mock("@/components/agent-sessions/agent-sessions-filter-sidebar", () => ({
	AgentSessionsFilterSidebar: () => null,
}))
vi.mock("@/components/agent-sessions/agent-sessions-toolbar", () => ({
	AgentSessionsToolbar: ({ actions }: { actions: ReactNode }) => <div>{actions}</div>,
}))
vi.mock("@/components/agent-sessions/tools/agent-sessions-tabs", () => ({
	AgentSessionsTabs: () => null,
}))

vi.mock("@/lib/agent-sessions/use-tool-analytics", () => ({
	useAgentSessionsTabCounts: () => ({}),
}))

vi.mock("@/hooks/use-organization-feature-flags", () => ({
	useOrganizationFeatureFlags: () => ({ flags: { agentTracing: true }, isLoaded: true }),
}))

vi.mock("@/hooks/use-infinite-ai-sessions", async () => {
	const { Result } = await vi.importActual<typeof import("@/lib/effect-atom")>("@/lib/effect-atom")
	return {
		useInfiniteAiSessions: (inputs: { startTime?: string; endTime?: string }) => {
			windows.list.push(inputs)
			return { firstPageResult: Result.initial(), allData: [], hasNextPage: false }
		},
	}
})

vi.mock("@/lib/services/atoms/warehouse-query-atoms", () => ({
	aiSessionsFacetsResultAtom: ({ data }: { data: { startTime: string; endTime: string } }) => {
		windows.facets.push(data)
		return "facets"
	},
	aiSessionsDistributionsResultAtom: () => "distributions",
}))

vi.mock("@/lib/effect-atom", async () => {
	const actual = await vi.importActual<typeof import("@/lib/effect-atom")>("@/lib/effect-atom")
	return { ...actual, useAtomValue: () => actual.Result.initial() }
})

import * as AgentSessionsRoute from "./index"
import { component as AgentSessionsPage } from "./index?tsr-split=component"

const lastListWindow = () => {
	const { startTime, endTime } = windows.list.at(-1)!
	return { startTime, endTime }
}

describe("AgentSessionsPage window", () => {
	beforeEach(() => {
		windows.list = []
		windows.facets = []
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-09-11T10:07:30Z"))
		vi.spyOn(AgentSessionsRoute.Route, "useSearch").mockReturnValue({})
	})

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("ends at now on a fresh mount, not at the cache grid", () => {
		render(<AgentSessionsPage />)

		expect(lastListWindow().endTime).toBe("2026-09-11 10:07:30")
		expect(windows.facets.at(-1)).toEqual(lastListWindow())
	})

	it("keeps the window across a filter change and rolls it on Reload", () => {
		const { rerender } = render(<AgentSessionsPage />)
		const mounted = lastListWindow()

		vi.setSystemTime(new Date("2026-09-11T10:09:00Z"))
		vi.spyOn(AgentSessionsRoute.Route, "useSearch").mockReturnValue({ hasErrors: true })
		rerender(<AgentSessionsPage />)

		expect(windows.list.at(-1)).toMatchObject({ ...mounted, hasErrors: true })
		expect(windows.facets.at(-1)).toEqual(mounted)

		act(() => fireEvent.click(screen.getByRole("button")))

		expect(lastListWindow().endTime).toBe("2026-09-11 10:09:00")
		expect(windows.facets.at(-1)).toEqual(lastListWindow())
	})
})
