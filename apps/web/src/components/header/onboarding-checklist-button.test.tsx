// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import type { V2OnboardingChecklist, V2OnboardingChecklistStep } from "@maple/domain/http/v2"
import { afterEach, expect, it } from "vitest"

import {
	formatCountdown,
	OnboardingChecklistPanel,
	type OnboardingChecklistPanelProps,
} from "./onboarding-checklist-button"

afterEach(cleanup)

const NOW = Date.parse("2026-07-27T12:00:00.000Z")

const checklist = (
	overrides: Partial<V2OnboardingChecklist> & { readonly done?: ReadonlyArray<string> } = {},
): V2OnboardingChecklist => {
	const done = new Set(overrides.done ?? [])
	const catalog: ReadonlyArray<Pick<V2OnboardingChecklistStep, "id" | "title" | "href">> = [
		{ id: "send_telemetry", title: "Send your first telemetry", href: "/settings?tab=ingestion" },
		{ id: "connect_github", title: "Connect GitHub", href: "/integrations?integration=github" },
		{ id: "create_alert_rule", title: "Create an alert with a destination", href: "/alerts" },
		{ id: "invite_teammate", title: "Invite a teammate", href: "/settings?tab=members" },
		{ id: "connect_mcp_agent", title: "Connect an MCP agent", href: "/settings?tab=mcp" },
	]
	const steps: V2OnboardingChecklist["steps"] = catalog.map((step) => ({
		object: "onboarding_checklist_step",
		...step,
		completed: done.has(step.id),
	}))
	const { done: _done, ...rest } = overrides
	return {
		object: "onboarding_checklist",
		status: "in_progress",
		reward_amount_usd: 30,
		deadline_at: new Date(NOW + 19 * 60 * 60 * 1000).toISOString(),
		claimed_at: null,
		completed_count: done.size,
		total_count: steps.length,
		steps,
		...rest,
	}
}

/** Undone steps are router links, so the panel renders inside a memory router rather than a stub. */
async function renderPanel(props: Partial<OnboardingChecklistPanelProps> = {}) {
	const full: OnboardingChecklistPanelProps = {
		checklist: checklist(),
		isAdmin: true,
		claimed: false,
		claimPending: false,
		claimError: null,
		onClaim: () => {},
		onDismiss: () => {},
		onClose: () => {},
		nowMs: NOW,
		...props,
	}
	const router = createRouter({
		routeTree: createRootRoute({ component: () => <OnboardingChecklistPanel {...full} /> }),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	})
	await router.load()
	render(<RouterProvider router={router} />)
}

it("links every undone step to where it is done and leaves done steps as plain rows", async () => {
	await renderPanel({ checklist: checklist({ done: ["send_telemetry", "connect_github"] }) })

	const github = screen.getByText("Connect GitHub")
	expect(github.closest("a")).toBeNull()

	const alerts = screen.getByRole("link", { name: /Create an alert with a destination/ })
	expect(alerts.getAttribute("href")).toBe("/alerts")
	const mcp = screen.getByRole("link", { name: /Connect an MCP agent/ })
	expect(mcp.getAttribute("href")).toBe("/settings?tab=mcp")

	expect(screen.getByText("2 of 5 done")).toBeTruthy()
	expect(screen.getByText("19:00:00")).toBeTruthy()
})

it("offers the claim to an admin once every step is done", async () => {
	let claimed = 0
	await renderPanel({
		checklist: checklist({
			status: "claimable",
			done: [
				"send_telemetry",
				"connect_github",
				"create_alert_rule",
				"invite_teammate",
				"connect_mcp_agent",
			],
		}),
		onClaim: () => {
			claimed += 1
		},
	})

	fireEvent.click(screen.getByRole("button", { name: "Claim $30 credits" }))
	expect(claimed).toBe(1)
	expect(screen.queryByRole("link")).toBeNull()
})

it("tells a member to find an admin rather than offering a claim that would 403", async () => {
	await renderPanel({
		checklist: checklist({
			status: "claimable",
			done: [
				"send_telemetry",
				"connect_github",
				"create_alert_rule",
				"invite_teammate",
				"connect_mcp_agent",
			],
		}),
		isAdmin: false,
	})

	expect(screen.getByText("All done. Ask an org admin to claim the credits.")).toBeTruthy()
	expect(screen.queryByRole("button", { name: /Claim/ })).toBeNull()
})

it("confirms the credit once claimed and lets the user close the panel", async () => {
	let closed = 0
	await renderPanel({
		checklist: checklist({ status: "claimed", claimed_at: new Date(NOW).toISOString() }),
		claimed: true,
		onClose: () => {
			closed += 1
		},
	})

	expect(screen.getByText("$30 credits added")).toBeTruthy()
	fireEvent.click(screen.getByRole("button", { name: "Done" }))
	expect(closed).toBe(1)
})

it("surfaces a failed claim next to the button instead of swallowing it", async () => {
	await renderPanel({
		checklist: checklist({ status: "claimable" }),
		claimError: "Billing is unavailable right now.",
	})

	expect(screen.getByText("Billing is unavailable right now.")).toBeTruthy()
})

it("counts down to the second and clamps at zero", () => {
	expect(formatCountdown(NOW + 19.5 * 60 * 60 * 1000, NOW)).toBe("19:30:00")
	expect(formatCountdown(NOW + 42 * 60 * 1000 + 7000, NOW)).toBe("00:42:07")
	expect(formatCountdown(NOW - 1, NOW)).toBe("00:00:00")
})
