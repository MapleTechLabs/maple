import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { contextSetupPrompt, missingContextItems, missingContextLine } from "./context-setup-prompt"

// The setup prompt and its hint ask only for what the errors are missing.

describe("context setup prompt", () => {
	test("both missing asks for the release and the user, in that order", () => {
		const prompt = contextSetupPrompt("checkout-api", { release: true, user: true })
		expect(prompt).toContain("service.version and user.id")
		expect(prompt).toContain("the checkout-api service")
		expect(prompt).toContain("1. Set the OpenTelemetry resource attribute `service.version`")
		expect(prompt).toContain("2. Set the span attribute `user.id`")
	})

	test("a missing user alone never asks for a release", () => {
		const prompt = contextSetupPrompt("checkout-api", { release: false, user: true })
		expect(prompt).not.toContain("service.version")
		expect(prompt).toContain("1. Set the span attribute `user.id`")
		expect(
			Arr.map(missingContextItems({ release: false, user: true }), (item) => item.attribute),
		).toEqual(["user.id"])
		expect(missingContextLine({ release: false, user: true })).toBe("See which users each error hits")
	})

	test("an unnamed service reads as this service", () => {
		expect(contextSetupPrompt("", { release: true, user: false })).toContain("of this service")
	})
})
