// @vitest-environment jsdom
// TEST-SEAM: Node's own experimental `localStorage` global shadows jsdom's and is
// undefined without `--localstorage-file`, so the store is stubbed in memory.
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getTheme, setTheme, useTheme } from "./use-theme"

const STORAGE_KEY = "maple-theme"
const store = new Map<string, string>()

beforeEach(() => {
	store.clear()
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
	})
	setTheme("dark")
})

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

describe("setTheme", () => {
	it("persists, applies the class and notifies subscribers", () => {
		const view = renderHook(() => useTheme())
		act(() => setTheme("light"))
		expect(view.result.current.theme).toBe("light")
		expect(getTheme()).toBe("light")
		expect(document.documentElement.classList.contains("light")).toBe(true)
		expect(document.documentElement.style.colorScheme).toBe("light")
		expect(store.get(STORAGE_KEY)).toBe("light")
	})

	it("with persist: false applies the theme without touching the viewer's stored choice", () => {
		const view = renderHook(() => useTheme())
		act(() => setTheme("light", { persist: false }))
		expect(view.result.current.theme).toBe("light")
		expect(document.documentElement.classList.contains("light")).toBe(true)
		expect(store.get(STORAGE_KEY)).toBe("dark")
	})
})
