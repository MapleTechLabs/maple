// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"

import { sessionTimeRangeAtomFor } from "@/atoms/session-time-range-atoms"
import { appRegistry } from "@/lib/registry"
import { setActiveOrgId } from "@/lib/services/common/auth-headers"

import {
	persistSessionTimeRange,
	sessionTimeRangeSearchMiddleware,
	subscribeSessionTimeRange,
} from "./session-time-range"

const next = <T>(search: T) => search
// TanStack hands middlewares present-but-undefined keys; mirror that here.
const pageSearch = { services: ["api"], timePreset: undefined }
const absolute = {
	startTime: "2026-09-01T00:00:00Z",
	endTime: "2026-09-02T00:00:00Z",
}

// Each test gets its own org: an `Atom.family` member lives for the process
// once read, so clearing sessionStorage would not reset a reused key.
afterEach(() => {
	setActiveOrgId(null)
})

describe("sessionTimeRangeSearchMiddleware", () => {
	it("fills a navigation that names no window with the remembered one", () => {
		setActiveOrgId("org_fill")
		appRegistry.set(sessionTimeRangeAtomFor("org_fill"), { timePreset: "7d" })

		expect(sessionTimeRangeSearchMiddleware()({ search: pageSearch, next })).toStrictEqual({
			services: ["api"],
			timePreset: "7d",
		})
		expect(JSON.parse(sessionStorage.getItem("maple.time-range.session.org_fill")!)).toEqual({
			timePreset: "7d",
		})
	})

	it("reads a window written by an earlier page load straight from storage", () => {
		setActiveOrgId("org_cold")
		sessionStorage.setItem("maple.time-range.session.org_cold", JSON.stringify(absolute))

		expect(sessionTimeRangeSearchMiddleware()({ search: {}, next })).toEqual(absolute)
	})

	it("keeps a window the navigation names itself, even a partial one", () => {
		setActiveOrgId("org_keep")
		appRegistry.set(sessionTimeRangeAtomFor("org_keep"), { timePreset: "7d" })

		expect(sessionTimeRangeSearchMiddleware()({ search: absolute, next })).toStrictEqual(absolute)
		const half = { startTime: absolute.startTime }
		expect(sessionTimeRangeSearchMiddleware()({ search: half, next })).toStrictEqual(half)
	})

	it("passes through when nothing is remembered, the value is malformed, or there is no org", () => {
		setActiveOrgId("org_untouched")
		expect(sessionTimeRangeSearchMiddleware()({ search: pageSearch, next })).toStrictEqual(pageSearch)

		setActiveOrgId("org_garbage")
		sessionStorage.setItem("maple.time-range.session.org_garbage", "{not json")
		expect(sessionTimeRangeSearchMiddleware()({ search: {}, next })).toStrictEqual({})

		setActiveOrgId("org_number")
		sessionStorage.setItem("maple.time-range.session.org_number", JSON.stringify({ timePreset: 123 }))
		expect(sessionTimeRangeSearchMiddleware()({ search: {}, next })).toStrictEqual({})

		setActiveOrgId("org_signed_out")
		appRegistry.set(sessionTimeRangeAtomFor("org_signed_out"), {
			timePreset: "7d",
		})
		setActiveOrgId(null)
		expect(sessionTimeRangeSearchMiddleware()({ search: {}, next })).toStrictEqual({})
	})

	it("scopes the remembered window to the org and keeps it across a switch", () => {
		setActiveOrgId("org_a")
		appRegistry.set(sessionTimeRangeAtomFor("org_a"), { timePreset: "7d" })

		setActiveOrgId("org_b")
		expect(sessionTimeRangeSearchMiddleware()({ search: {}, next })).toStrictEqual({})

		setActiveOrgId("org_a")
		expect(sessionTimeRangeSearchMiddleware()({ search: {}, next })).toStrictEqual({ timePreset: "7d" })
	})
})

describe("persistSessionTimeRange", () => {
	it("remembers a preset, then an absolute window, and ignores locations without one", () => {
		setActiveOrgId("org_persist")
		const atom = sessionTimeRangeAtomFor("org_persist")

		persistSessionTimeRange({ timePreset: "24h" })
		expect(appRegistry.get(atom)).toStrictEqual({ timePreset: "24h" })

		persistSessionTimeRange(absolute)
		expect(appRegistry.get(atom)).toStrictEqual(absolute)

		persistSessionTimeRange({})
		persistSessionTimeRange({ startTime: absolute.startTime })
		persistSessionTimeRange({ startTime: "not a time", endTime: "nor this" })
		persistSessionTimeRange({ startTime: absolute.endTime, endTime: absolute.startTime })
		expect(appRegistry.get(atom)).toStrictEqual(absolute)
	})

	it("does nothing without an org", () => {
		const before = sessionStorage.length
		persistSessionTimeRange({ timePreset: "24h" })
		expect(appRegistry.get(sessionTimeRangeAtomFor(null))).toStrictEqual({})
		expect(sessionStorage.length).toBe(before)
	})
})

describe("subscribeSessionTimeRange", () => {
	it("persists the resolved location's window", () => {
		setActiveOrgId("org_router")
		const subscribe = vi.fn(
			(_event: string, handler: (event: { toLocation: { search: unknown } }) => void) => {
				handler({ toLocation: { search: { timePreset: "3d" } } })
				return () => {}
			},
		)

		subscribeSessionTimeRange({ subscribe } as never)

		expect(subscribe).toHaveBeenCalledWith("onResolved", expect.any(Function))
		expect(appRegistry.get(sessionTimeRangeAtomFor("org_router"))).toStrictEqual({ timePreset: "3d" })
	})
})

describe("sessionTimeRangeSearchMiddleware ceiling", () => {
	const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60

	it("ignores a remembered window wider than the page supports", () => {
		setActiveOrgId("org_ceiling")
		appRegistry.set(sessionTimeRangeAtomFor("org_ceiling"), {
			timePreset: "12mo",
		})

		expect(sessionTimeRangeSearchMiddleware()({ search: {}, next })).toStrictEqual({})
		expect(
			sessionTimeRangeSearchMiddleware({ maxRangeSeconds: ONE_YEAR_SECONDS })({
				search: {},
				next,
			}),
		).toStrictEqual({ timePreset: "12mo" })

		const wide = {
			startTime: "2026-01-01T00:00:00Z",
			endTime: "2026-03-01T00:00:00Z",
		}
		appRegistry.set(sessionTimeRangeAtomFor("org_ceiling"), wide)
		expect(sessionTimeRangeSearchMiddleware()({ search: {}, next })).toStrictEqual({})
		expect(
			sessionTimeRangeSearchMiddleware({ maxRangeSeconds: ONE_YEAR_SECONDS })({
				search: {},
				next,
			}),
		).toStrictEqual(wide)
	})

	it("lets a month-wide preset through everywhere", () => {
		setActiveOrgId("org_month")
		appRegistry.set(sessionTimeRangeAtomFor("org_month"), {
			timePreset: "1mo",
		})
		expect(sessionTimeRangeSearchMiddleware()({ search: {}, next })).toStrictEqual({ timePreset: "1mo" })
	})
})
