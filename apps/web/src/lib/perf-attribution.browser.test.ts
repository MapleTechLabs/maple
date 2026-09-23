import { afterEach, describe, expect, it } from "vitest"
import { regionOf } from "./perf-attribution"

const shell = `
	<div data-slot="sidebar"><a id="nav-link">Traces</a></div>
	<main data-slot="sidebar-inset">
		<div data-slot="page-layout">
			<header data-slot="app-topbar"><button id="topbar-button">Chat</button></header>
			<div id="banner">Update available</div>
			<div data-slot="page-body">
				<aside data-slot="page-filter-sidebar"><input id="filter" /></aside>
				<div data-slot="page-content">
					<div data-slot="page-sticky-area"><div data-slot="page-header"><h1 id="title">Traces</h1></div></div>
					<div data-slot="page-scroll-area"><span id="row">row text</span></div>
				</div>
				<aside data-slot="page-right-sidebar"><p id="context">Context</p></aside>
			</div>
		</div>
	</main>
	<div role="dialog"><button id="dialog-button">OK</button></div>
	<div id="sign-in">Sign in</div>
`

const byId = (id: string) => document.getElementById(id)

afterEach(() => {
	document.body.innerHTML = ""
})

describe("regionOf", () => {
	it("names each app-shell region from its data-slot", () => {
		document.body.innerHTML = shell
		expect(regionOf(byId("nav-link"))).toBe("sidebar")
		expect(regionOf(byId("topbar-button"))).toBe("topbar")
		expect(regionOf(byId("banner"))).toBe("shell")
		expect(regionOf(byId("filter"))).toBe("filters")
		expect(regionOf(byId("row"))).toBe("content")
		expect(regionOf(byId("context"))).toBe("right-panel")
		expect(regionOf(byId("dialog-button"))).toBe("overlay")
		expect(regionOf(byId("sign-in"))).toBe("other")
	})

	it("prefers the nearest region, so the sticky page header is not read as content", () => {
		document.body.innerHTML = shell
		expect(regionOf(byId("title"))).toBe("page-header")
	})

	it("resolves a text node through its parent element", () => {
		document.body.innerHTML = shell
		expect(regionOf(byId("row")?.firstChild)).toBe("content")
	})

	it("reports elements removed before the vital fired as detached", () => {
		document.body.innerHTML = shell
		const row = byId("row")
		row?.remove()
		expect(regionOf(row)).toBe("detached")
		expect(regionOf(null)).toBe("detached")
		expect(regionOf(undefined)).toBe("detached")
	})
})
