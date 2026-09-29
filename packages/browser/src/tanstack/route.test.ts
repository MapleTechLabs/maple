import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	notFound,
} from "@tanstack/react-router"
import { describe, expect, it } from "vitest"
import { routeTemplate } from "./route"

const rootRoute = createRootRoute()
const index = createRoute({ getParentRoute: () => rootRoute, path: "/" })
const projects = createRoute({ getParentRoute: () => rootRoute, path: "/projects" })
const project = createRoute({
	getParentRoute: () => projects,
	path: "$id",
	loader: ({ params }) => {
		if (params.id === "missing") throw notFound()
	},
})
const authed = createRoute({ getParentRoute: () => rootRoute, id: "_authed" })
const settings = createRoute({ getParentRoute: () => authed, path: "/settings" })
const routeTree = rootRoute.addChildren([
	index,
	projects.addChildren([project]),
	authed.addChildren([settings]),
])

/** The template of the route the router settles on for `url`, as the server's handler callback sees it. */
const templateAt = async (url: string) => {
	const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [url] }) })
	await router.load()
	return routeTemplate(router)
}

describe("routeTemplate", () => {
	it("names a route by its full path, with params left as `$name`", async () => {
		expect(await templateAt("/projects/8f2a")).toBe("/projects/$id")
		expect(await templateAt("/projects/8f2a?tab=members#top")).toBe("/projects/$id")
		expect(await templateAt("/")).toBe("/")
	})

	it("leaves out pathless layouts", async () => {
		expect(await templateAt("/settings")).toBe("/settings")
	})

	it("names a URL no route matches not-found, not after the route rendering the not-found page", async () => {
		expect(await templateAt("/does-not-exist")).toBe("not-found")
		// `/projects` matches and renders the not-found page for the rest
		expect(await templateAt("/projects/1/extra")).toBe("not-found")
	})

	it("keeps the route of a loader that threw notFound()", async () => {
		expect(await templateAt("/projects/missing")).toBe("/projects/$id")
	})
})
