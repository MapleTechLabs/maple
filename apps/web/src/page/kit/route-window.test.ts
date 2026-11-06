import { describe, expect, test } from "vitest"
import { routeWindowStep, snapModeOf, type WindowFields } from "./route-window"

const step = (previous: WindowFields & { readonly metric?: string }, next: WindowFields & { readonly metric?: string }) =>
	routeWindowStep(previous, next, {
		resolve: () => "resolve",
		requestAll: (mode) => `request:${mode}`,
	})

describe("route window", () => {
	test("a URL change outside the window keeps it and requests in Load, even after a Reload", () => {
		expect(step({ timePreset: "1h", metric: "calls" }, { timePreset: "1h", metric: "errors" })).toBe("request:Load")
	})

	test("a moved window re-resolves, unsnapped once the page was reloaded", () => {
		expect(step({ timePreset: "1h" }, { timePreset: "6h" })).toBe("resolve")
		expect(step({ timePreset: "1h" }, { startTime: "a", endTime: "b" })).toBe("resolve")
		expect(snapModeOf(0)).toBe("Load")
		expect(snapModeOf(2)).toBe("Refresh")
	})
})
