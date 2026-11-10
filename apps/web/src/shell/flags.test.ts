import { describe, expect, test, vi } from "vitest"

// The shell's favorites listener targets `window` at import.
vi.hoisted(() => Object.assign(globalThis, { window: new EventTarget() }))
import { isSidebarOpenIn } from "./flags"
import { init } from "./model"

const flags = { isMobile: false, theme: "light" as const, pinnedNamespaces: {}, dashboardFavorites: [] }

const initWithCookie = (cookie: string) => init({ ...flags, isSidebarOpen: isSidebarOpenIn(cookie) })

describe("the sidebar's remembered state", () => {
	test("a sidebar collapsed before the reload starts collapsed", () => {
		expect(initWithCookie("theme=dark; sidebar_state=false; other=1").isSidebarOpen).toBe(false)
	})

	test("a sidebar left open, or never toggled, starts open", () => {
		expect(initWithCookie("theme=dark; sidebar_state=true").isSidebarOpen).toBe(true)
		expect(initWithCookie("").isSidebarOpen).toBe(true)
		expect(init(flags).isSidebarOpen).toBe(true)
	})

	test("another cookie that only ends in the same text is not the sidebar's", () => {
		expect(initWithCookie("my_sidebar_state=false").isSidebarOpen).toBe(true)
	})
})
