import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { Suggestion } from "./suggestion"

afterEach(() => {
	cleanup()
})

const LONG =
	"Diagnose subscriptions-api public endpoints (GET /public/v1/users/:appUserIdOrDeviceId/entitlements)"

describe("Suggestion", () => {
	it("keeps the full text reachable when it truncates", () => {
		render(<Suggestion suggestion={LONG} />)
		expect(screen.getByRole("button").getAttribute("title")).toBe(LONG)
	})

	it("leaves the title off when the caller supplies its own label", () => {
		render(<Suggestion suggestion={LONG}>Short label</Suggestion>)
		expect(screen.getByRole("button").getAttribute("title")).toBeNull()
	})
})
