// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { afterEach, expect, it } from "vitest"

import type { SignalPresence } from "@/hooks/use-signal-presence"
import { SignalEmptyStateView, type SignalEmptyStateProps } from "./signal-empty-state"

afterEach(cleanup)

/** The setup CTA is a router link, so these render inside a memory router rather than a stub. */
async function renderState(props: SignalEmptyStateProps & { readonly presence: SignalPresence }) {
	const router = createRouter({
		routeTree: createRootRoute({ component: () => <SignalEmptyStateView {...props} /> }),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	})
	await router.load()
	render(<RouterProvider router={router} />)
}

it("tells a user who has never sent the signal how to send it", async () => {
	await renderState({ signal: "logs", presence: { status: "absent", lastSeen: null } })

	expect(screen.getByText("No logs yet")).toBeTruthy()
	expect(screen.getByText(/OTLP log bridge/)).toBeTruthy()
	expect(screen.getByText("Set up logging")).toBeTruthy()
})

it("tells a user whose signal is wired up that the window is quiet, and when it last arrived", async () => {
	const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000
	await renderState({ signal: "logs", presence: { status: "present", lastSeen: threeDaysAgo } })

	expect(screen.getByText("No logs in this time range")).toBeTruthy()
	// The distinction the whole feature exists for: never advise setup to someone already set up.
	expect(screen.queryByText(/OTLP log bridge/)).toBeNull()
	expect(screen.getByText(/Maple last received logs/)).toBeTruthy()
})

it("blames the filters when filters are active, whatever presence says", async () => {
	// Even on an org that has never sent the signal: the user narrowed the view themselves, so that
	// is the question they are asking. Setup advice would answer a different one.
	await renderState({
		signal: "traces",
		presence: { status: "absent", lastSeen: null },
		filtered: true,
		onClearFilters: () => {},
	})

	expect(screen.getByText("No traces match these filters")).toBeTruthy()
	expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy()
	expect(screen.queryByText(/OpenTelemetry SDK/)).toBeNull()
})

it("offers no advice at all while presence is unreadable", async () => {
	// Guessing here would flash "you haven't set this up" at someone who has.
	await renderState({ signal: "metrics", presence: { status: "unknown", lastSeen: null } })

	expect(screen.getByText("No metrics found")).toBeTruthy()
	expect(screen.queryByText(/^Set up /)).toBeNull()
	expect(screen.queryByText(/metric reader/)).toBeNull()
})

it("uses the page's noun for the heading but the signal's noun for the timestamp", async () => {
	// Services are listed from trace data, so "your most recent service arrived" is nonsense.
	await renderState({
		signal: "traces",
		noun: "services",
		presence: { status: "present", lastSeen: Date.now() - 60 * 60 * 1000 },
	})

	expect(screen.getByText("No services in this time range")).toBeTruthy()
	expect(screen.getByText(/Maple last received traces/)).toBeTruthy()
})
