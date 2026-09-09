import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { NavBarInner } from "./NavBar"

const render = (signedIn: boolean) => renderToStaticMarkup(<NavBarInner stars={null} signedIn={signedIn} />)

describe("NavBar auth state", () => {
	it("signed out: offers Log in and the sign-up CTA", () => {
		const html = render(false)
		expect(html).toContain('data-track-location="nav_login"')
		expect(html).toContain("Log in")
		expect(html).toContain("Start free trial")
		expect(html).not.toContain("Dashboard")
	})

	it("signed in: hides Log in and points the CTA at the app", () => {
		const html = render(true)
		expect(html).not.toContain('data-track-location="nav_login"')
		expect(html).not.toContain("Log in")
		expect(html).not.toContain("Start free trial")
		expect(html).toContain("Dashboard")
		expect(html).toContain('href="https://app.maple.dev"')
	})
})
