import { describe, expect, it } from "vitest"
import { cn } from "./utils"
import { cx, variants } from "./variants"

const chip = variants("chip", {
	variants: {
		size: { sm: "h-4", md: "h-6" },
		tone: { plain: "", ok: "text-ok", crit: "text-crit" },
		pill: { false: "rounded-sm", true: "rounded-full" },
	},
	defaultVariants: { size: "md", tone: "plain", pill: false },
	compoundVariants: [
		{ class: "px-2", pill: true, size: "md" },
		{ class: "px-1", pill: true, size: ["sm"] },
		{ class: "ring", tone: ["ok", "crit"] },
	],
})

describe("cx", () => {
	it("joins truthy values with single spaces and flattens nested arrays", () => {
		expect(cx("a", undefined, null, false, "", "b")).toBe("a b")
		expect(cx(["a", ["b", [false, "c"]]], "d")).toBe("a b c d")
		expect(cx([], [[]], "")).toBe("")
	})

	it("keeps non-zero numbers and drops zero", () => {
		expect(cx(1, 0, "x")).toBe("1 x")
	})
})

describe("variants", () => {
	it("emits base, then variants in declaration order, then compounds, then className", () => {
		expect(chip({ size: "sm", tone: "ok", pill: true, className: "extra" })).toBe(
			"chip h-4 text-ok rounded-full px-1 ring extra",
		)
	})

	it("falls back to defaults for undefined selections and applies default-driven compounds", () => {
		expect(chip()).toBe("chip h-6 rounded-sm")
		expect(chip({ pill: true })).toBe("chip h-6 rounded-full px-2")
	})

	it("treats null as no class for that variant but keeps the default for compound matching", () => {
		expect(chip({ size: null, pill: true })).toBe("chip rounded-full")
		expect(chip({ tone: null })).toBe("chip h-6 rounded-sm")
	})

	it("selects the false key for an explicit false", () => {
		expect(chip({ pill: false })).toBe("chip h-6 rounded-sm")
	})

	it("works with a base class only", () => {
		expect(variants("only")({ className: ["a", false] })).toBe("only a")
	})
})

describe("cn", () => {
	it("resolves Tailwind conflicts after joining", () => {
		expect(cn("px-2", false, ["px-4", "text-ui"], "text-red-500")).toBe("px-4 text-ui text-red-500")
	})
})
