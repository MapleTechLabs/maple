// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentSessionsToolbar } from "./agent-sessions-toolbar"

describe("AgentSessionsToolbar", () => {
	afterEach(cleanup)

	it("toggles the error filter and counts the loaded sessions", () => {
		const onToggleErrorsOnly = vi.fn()
		render(
			<AgentSessionsToolbar
				query=""
				onSearch={vi.fn()}
				errorsOnly={false}
				onToggleErrorsOnly={onToggleErrorsOnly}
				sessionCount={12}
			/>,
		)

		// The error filter is a switch: on or off, never a button that looks
		// like a warning about the list.
		const errors = screen.getByRole("switch", { name: "With errors" })
		expect(errors.getAttribute("aria-checked")).toBe("false")
		fireEvent.click(errors)
		expect(onToggleErrorsOnly).toHaveBeenCalledOnce()
		expect(screen.getByText("12")).toBeTruthy()
		expect(screen.getByPlaceholderText("Session or trace ID…")).toBeTruthy()
	})

	// A count that reads zero for a beat above a list about to fill is worse
	// than one that arrives a beat late — the same call /replays makes.
	it("holds the count back until the first page lands", () => {
		render(
			<AgentSessionsToolbar
				query=""
				onSearch={vi.fn()}
				errorsOnly={false}
				onToggleErrorsOnly={vi.fn()}
				sessionCount={undefined}
			/>,
		)
		expect(screen.queryByText("sessions")).toBeNull()
	})
})
