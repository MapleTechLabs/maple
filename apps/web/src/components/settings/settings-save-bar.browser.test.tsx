import { act, cleanup, render, screen } from "@testing-library/react"
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router"
import type { ReactNode } from "react"
import { afterEach, expect, it } from "vitest"

import { type SettingsDraft, useSettingsDraft } from "./settings-draft"
import { SettingsSaveBar } from "./settings-save-bar"

afterEach(cleanup)

/** The latest render of the form under test, so the test can drive it. */
interface RenderedForm {
	form?: SettingsDraft<number>
}

async function renderBar({ dirty, pending }: { dirty: boolean; pending: boolean }) {
	return renderSettingsPage(() => (
		<SettingsSaveBar dirty={dirty} pending={pending} onDiscard={() => {}} onSave={() => {}} />
	))
}

async function renderSettingsPage(page: () => ReactNode) {
	const rootRoute = createRootRoute({ component: () => <Outlet /> })
	const settings = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: page,
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

it("asks before leaving after reverting an edit whose save is still in flight", async () => {
	const page: RenderedForm = {}
	const router = await renderSettingsPage(function Page() {
		const form = useSettingsDraft(10)
		page.form = form
		return <SettingsSaveBar dirty={form.isDirty} pending onDiscard={() => {}} onSave={() => {}} />
	})
	act(() => page.form?.setDraft(50))
	act(() => {
		page.form?.submit()
	})
	act(() => page.form?.setDraft(10))
	await act(async () => {
		void router.navigate({ to: "/account" })
	})

	expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy()
	expect(router.state.location.pathname).toBe("/")
})
