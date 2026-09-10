// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { sessionTimeRangeAtomFor } from "@/atoms/session-time-range-atoms"
import { appRegistry } from "@/lib/registry"
import { setActiveOrgId } from "@/lib/services/common/auth-headers"

import { persistSessionTimeRange, sessionTimeRangeSearchMiddleware } from "./session-time-range"

const next = <T>(search: T) => search
// TanStack hands middlewares present-but-undefined keys; mirror that here.
const pageSearch = { services: ["api"], timePreset: undefined }

describe("sessionTimeRangeSearchMiddleware", () => {
	beforeEach(() => {
		sessionStorage.clear()
		setActiveOrgId("org_1")
	})

	afterEach(() => {
		setActiveOrgId(null)
	})

	it("fills a navigation that names no window with the remembered one", () => {
		appRegistry.set(sessionTimeRangeAtomFor("org_1"), { timePreset: "7d" })

		expect(sessionTimeRangeSearchMiddleware({ search: pageSearch, next })).toEqual({
			services: ["api"],
			timePreset: "7d",
		})
		expect(sessionStorage.getItem("maple.time-range.session.org_1")).toContain('"7d"')
	})

	it("keeps a window the navigation names itself", () => {
		appRegistry.set(sessionTimeRangeAtomFor("org_1"), { timePreset: "7d" })
		const search = { startTime: "2026-09-01T00:00:00Z", endTime: "2026-09-02T00:00:00Z" }

		expect(sessionTimeRangeSearchMiddleware({ search, next })).toEqual(search)
	})

	it("passes through when nothing is remembered or there is no org", () => {
		setActiveOrgId("org_untouched")
		expect(sessionTimeRangeSearchMiddleware({ search: pageSearch, next })).toEqual({
			services: ["api"],
		})

		appRegistry.set(sessionTimeRangeAtomFor("org_1"), { timePreset: "7d" })
		setActiveOrgId(null)
		expect(sessionTimeRangeSearchMiddleware({ search: {}, next })).toEqual({})
	})

	it("scopes the remembered window to the org", () => {
		appRegistry.set(sessionTimeRangeAtomFor("org_1"), { timePreset: "7d" })
		setActiveOrgId("org_2")

		expect(sessionTimeRangeSearchMiddleware({ search: {}, next })).toEqual({})
	})
})

describe("persistSessionTimeRange", () => {
	afterEach(() => {
		setActiveOrgId(null)
	})

	it("remembers a preset, then an absolute window, and ignores locations without one", () => {
		setActiveOrgId("org_persist")
		const atom = sessionTimeRangeAtomFor("org_persist")

		persistSessionTimeRange({ timePreset: "24h" })
		expect(appRegistry.get(atom)).toEqual({ timePreset: "24h" })

		persistSessionTimeRange({ startTime: "2026-09-01T00:00:00Z", endTime: "2026-09-02T00:00:00Z" })
		expect(appRegistry.get(atom)).toEqual({
			startTime: "2026-09-01T00:00:00Z",
			endTime: "2026-09-02T00:00:00Z",
		})

		persistSessionTimeRange({})
		expect(appRegistry.get(atom).startTime).toBe("2026-09-01T00:00:00Z")
	})

	it("does nothing without an org", () => {
		setActiveOrgId(null)
		persistSessionTimeRange({ timePreset: "24h" })
		expect(sessionStorage.getItem("maple.time-range.session.null")).toBeNull()
	})
})
