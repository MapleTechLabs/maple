import { Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { renderStatusPageConfirmEmail, renderStatusPageUpdateEmail } from "./status-page-subscription"

describe("renderStatusPageUpdateEmail", () => {
	const html = renderStatusPageUpdateEmail({
		pageName: "Acme",
		kindLabel: "Incident",
		statusLabel: "Investigating",
		title: "Errors <b>& timeouts</b>",
		body: "First paragraph.\n\nSecond <script>alert(1)</script>",
		affected: "API",
		postedAt: "Oct 28, 2026, 12:00 UTC",
		accentColor: "#e8872a",
		pageUrl: "https://status.example/s/acme#incident-1",
		unsubscribeUrl: "https://status.example/s/acme/unsubscribe?token=abc",
	})

	it("splits the body into escaped paragraphs and escapes the title", () => {
		const paragraphs = Arr.map(
			Arr.fromIterable(Str.matchAll(/<p[^>]*white-space:pre-wrap[^>]*>([^<]*)<\/p>/gu)(html)),
			(match) => match[1],
		)
		expect(paragraphs).toEqual(["First paragraph.", "Second &lt;script&gt;alert(1)&lt;/script&gt;"])
		expect(html).toContain("Errors &lt;b&gt;&amp; timeouts&lt;/b&gt;")
		expect(html).not.toContain("<script>")
	})

	it("links to the page and to unsubscribe", () => {
		expect(html).toContain(`href="https://status.example/s/acme#incident-1"`)
		expect(html).toContain(`href="https://status.example/s/acme/unsubscribe?token=abc"`)
	})
})

describe("renderStatusPageConfirmEmail", () => {
	it("carries the confirmation link and what the subscription covers", () => {
		const html = renderStatusPageConfirmEmail({
			pageName: "Acme",
			scope: "API, Dashboard",
			confirmUrl: "https://status.example/s/acme/subscribe/confirm?token=t",
			expiresIn: "48 hours",
		})
		expect(html).toContain(`href="https://status.example/s/acme/subscribe/confirm?token=t"`)
		expect(html).toContain("Acme status page: API, Dashboard.")
		expect(html).toContain("expires in 48 hours")
	})
})
