import { describe, expect, test } from "vitest"
import { documentTitleOf } from "./chrome"

describe("documentTitleOf", () => {
	test("leads with the page's own name, then its parent", () => {
		expect(documentTitleOf([{ label: "Services", href: "/services" }, { label: "checkout-api" }])).toBe(
			"checkout-api · Services · Maple",
		)
	})

	test("a name that is still loading leaves the tab on its parent", () => {
		expect(documentTitleOf([{ label: "Traces", href: "/traces" }, { label: "Loading…" }])).toBe(
			"Traces · Maple",
		)
	})

	test("a deep trail keeps its last two names", () => {
		expect(
			documentTitleOf([
				{ label: "Alerts", href: "/alerts" },
				{ label: "Rules", href: "/alerts/rules" },
				{ label: "High error rate" },
			]),
		).toBe("High error rate · Rules · Maple")
	})

	test("no trail is the app's name alone", () => {
		expect(documentTitleOf([])).toBe("Maple")
	})
})
