// @vitest-environment happy-dom
import { MapleBrowser } from "@maple-dev/browser"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { Island } from "../foldkit-island/island"
import { Array as Arr } from "effect"

// The header reads the publishable key when its module loads, so the modules load after the stub.
let NavBar: Island
let start: typeof import("../foldkit-island/client").default
let renderer: typeof import("../foldkit-island/server").default
beforeAll(async () => {
	vi.stubEnv("PUBLIC_CLERK_PUBLISHABLE_KEY", `pk_test_${btoa("clerk.maple.test$")}`)
	;({ NavBar } = await import("./NavBar"))
	start = (await import("../foldkit-island/client")).default
	renderer = (await import("../foldkit-island/server")).default
})

const props = { locale: "en", stars: 1900 }
const mounted: Array<HTMLElement> = []

const mount = async (): Promise<HTMLElement> => {
	const element = document.body.appendChild(document.createElement("astro-island"))
	element.innerHTML = (await renderer.renderToStaticMarkup(NavBar, props)).html
	await start(element)(NavBar, props)
	mounted.push(element)
	return element
}
const navCta = () => document.querySelector('a[data-track-location="nav"]')

const stubClerk = (userId: string | null) => {
	const load = vi.fn(async () => undefined)
	window.Clerk = {
		load,
		addListener: (listener) => {
			listener({
				session: userId === null ? null : { status: "active" },
				user: userId === null ? null : { id: userId },
			})
			return () => undefined
		},
	}
	return load
}

afterEach(() => {
	Arr.forEach(mounted.splice(0), (element) => element.dispatchEvent(new Event("astro:unmount")))
	document.body.innerHTML = ""
	document.cookie = "__client_uat=; expires=Thu, 01 Jan 1970 00:00:00 GMT"
	window.Clerk = undefined
	window.__mapleSignedIn = undefined
	vi.restoreAllMocks()
})

describe("NavBar island", () => {
	it("renders signed out on the server: Log in and the sign-up CTA, the localized links", async () => {
		const html = (await renderer.renderToStaticMarkup(NavBar, { locale: "ja", stars: null })).html
		expect(html).toContain('data-track-location="nav_login"')
		expect(html).toContain('href="https://app.maple.dev/sign-up"')
		expect(html).not.toContain('href="https://app.maple.dev"')
		expect(html).toContain('href="/ja/pricing"')
		expect(html).toContain('aria-label="GitHub"')
	})

	it("a Clerk session flips the header to Dashboard, tells the page and names the visitor", async () => {
		document.cookie = "__client_uat=1730000000"
		const load = stubClerk("user_1")
		const identify = vi.spyOn(MapleBrowser, "identify").mockImplementation(() => undefined)
		const heard: Array<unknown> = []
		document.addEventListener("maple:signed-in", (event) =>
			heard.push(event instanceof CustomEvent && event.detail),
		)
		await mount()
		await vi.waitFor(() => expect(navCta()?.textContent).toBe("Dashboard"))
		expect(navCta()?.getAttribute("href")).toBe("https://app.maple.dev")
		expect(document.querySelector('[data-track-location="nav_login"]')).toBeNull()
		expect(load).toHaveBeenCalledTimes(1)
		expect(heard).toEqual([false, true])
		expect(window.__mapleSignedIn).toBe(true)
		expect(identify.mock.calls).toEqual([[null], [{ id: "user_1" }]])
	})

	it("without Clerk's session cookie it stays signed out and never loads clerk-js", async () => {
		document.cookie = "__client_uat=0"
		const load = stubClerk("user_1")
		await mount()
		await vi.waitFor(() => expect(window.__mapleSignedIn).toBe(false))
		expect(load).not.toHaveBeenCalled()
		expect(navCta()?.textContent).toBe("Start free trial")
	})

	it("the menu button opens the sheet; a link in it closes the sheet", async () => {
		await mount()
		const open = document.querySelector('button[aria-label="Open menu"]')
		expect(open).toBeInstanceOf(HTMLButtonElement)
		open?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
		const pricing = [...document.querySelectorAll('[role="dialog"] a')].find(
			(a) => a.textContent === "Pricing",
		)
		expect(pricing?.getAttribute("href")).toBe("/pricing")
		pricing?.addEventListener("click", (event) => event.preventDefault())
		pricing?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
		await vi.waitFor(() => expect(open?.getAttribute("aria-expanded")).toBe("false"))
	})

	it("clicking Product opens the mega-menu with every section", async () => {
		await mount()
		const product = [...document.querySelectorAll("button")].find((b) =>
			b.textContent?.startsWith("Product"),
		)
		product?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
		await vi.waitFor(() => expect(product?.getAttribute("aria-expanded")).toBe("true"))
		const text = document.body.textContent ?? ""
		for (const section of ["Features", "Use Cases", "Integrations", "Compare", "Maple vs Honeycomb"])
			expect(text).toContain(section)
	})
})
