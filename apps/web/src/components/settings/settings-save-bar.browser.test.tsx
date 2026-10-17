import { act, cleanup, render, screen } from "@testing-library/react"
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router"
import { afterEach, expect, it } from "vitest"

import { SettingsSaveBar } from "./settings-save-bar"

afterEach(cleanup)

async function renderBar({ dirty, pending }: { dirty: boolean; pending: boolean }) {
	const rootRoute = createRootRoute({ component: () => <Outlet /> })
	const settings = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => (
			<SettingsSaveBar dirty={dirty} pending={pending} onDiscard={() => {}} onSave={() => {}} />
		),
	})
	const account = createRoute({
		getParentRoute: () => rootRoute,
		path: "/account",
		component: () => "Other page",
	})
	const router = createRouter({
		routeTree: rootRoute.addChildren([settings, account]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	})
	await router.load()
	render(<RouterProvider router={router} />)
	return router
}

it("asks before leaving while a save is still in flight", async () => {
	const router = await renderBar({ dirty: true, pending: true })

	await act(async () => {
		void router.navigate({ to: "/account" })
	})

	expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy()
	expect(router.state.location.pathname).toBe("/")
})

it("lets the user leave without a prompt once the save committed", async () => {
	const router = await renderBar({ dirty: false, pending: false })

	await act(async () => {
		await router.navigate({ to: "/account" })
	})

	expect(screen.queryByText("Discard unsaved changes?")).toBeNull()
	expect(router.state.location.pathname).toBe("/account")
})
