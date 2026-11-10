import type { StatusPageFreshness } from "@maple/domain/status-page"
import { Array as Arr, Option, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { FIXTURE_NOW, fixtureComponentId, makeSnapshot } from "./fixtures"
import { renderPage, renderSubscriptionPage } from "./index"

const live: StatusPageFreshness = { _tag: "live", updatedAt: FIXTURE_NOW - 60_000 }
const SHARED = { basePath: "/s/acme", publicUrl: "https://status.maple.workers.dev/s/acme" }

/** The text after the first `open`, up to the next `close`; "" when `open` is absent. */
const between = (text: string, open: string, close: string): string =>
	Option.match(Arr.get(Str.split(open)(text), 1), {
		onNone: () => "",
		onSome: (after) => Str.split(close)(after)[0] ?? "",
	})

/** The subscribe dialog, from its opening tag to the delayed-data notice that follows it. */
const dialog = (html: string): string => between(html, `id="subscribe"`, `id="delayed"`)

const componentIdsIn = (html: string) =>
	Arr.map(
		Arr.fromIterable(Str.matchAll(/name="componentIds" value="([^"]+)"/gu)(html)),
		(match) => match[1],
	)

describe("the subscribe dialog", () => {
	it("opens from the header's link, with or without script, as the target the Worker redirects to", () => {
		const html = renderPage(makeSnapshot(), live, FIXTURE_NOW, SHARED)
		expect(between(html, "<header", "</header>")).toContain(`href="#subscribe">Subscribe to updates</a>`)
		expect(dialog(html)).toContain(`role="dialog"`)
	})

	it("offers email for all components or a pick of them, the feeds at the page's address, and a Slack command", () => {
		const snapshot = makeSnapshot()
		const section = dialog(renderPage(snapshot, live, FIXTURE_NOW, SHARED))

		expect(section).toContain(`<form class="sub-form" method="post" action="/s/acme/subscribe">`)
		expect(section).toContain(`name="scope" value="all" checked`)
		expect(section).toContain(`name="scope" value="some"`)
		expect(componentIdsIn(section)).toEqual(Arr.map(snapshot.components, (component) => component.id))
		expect(section).toContain(`value="https://status.maple.workers.dev/s/acme/feed.rss"`)
		expect(section).toContain(`value="https://status.maple.workers.dev/s/acme/feed.atom"`)
		expect(section).toContain(`value="/feed subscribe https://status.maple.workers.dev/s/acme/feed.rss"`)
	})

	it("lists the components to pick under their groups", () => {
		const section = dialog(renderPage(makeSnapshot(), live, FIXTURE_NOW, SHARED))
		expect(componentIdsIn(between(section, `aria-label="Platform"`, "</div></div>"))).toEqual([
			fixtureComponentId(0),
			fixtureComponentId(1),
		])
	})

	it("is the page's only subscribe form", () => {
		const html = renderPage(makeSnapshot(), live, FIXTURE_NOW, SHARED)
		expect(Str.split(`name="email"`)(html)).toHaveLength(2)
	})

	it("leaves out the Slack command when the page's public address is unknown, and links the feeds under its base", () => {
		const section = dialog(renderPage(makeSnapshot(), live, FIXTURE_NOW, { basePath: "/s/acme" }))
		expect(section).not.toContain("/feed subscribe")
		expect(section).toContain(`value="/s/acme/feed.rss"`)
	})

	it("asks only for an address on a page without components", () => {
		const section = dialog(renderPage(makeSnapshot({ components: [] }), live, FIXTURE_NOW, SHARED))
		expect(section).toContain(`name="email"`)
		expect(section).not.toContain(`name="scope"`)
		expect(section).not.toContain(fixtureComponentId(0))
	})

	it("links the page's terms and privacy policy where the visitor agrees to them", () => {
		const page = { ...makeSnapshot().page, termsUrl: "https://acme.example/terms", privacyUrl: null }
		const section = dialog(renderPage(makeSnapshot({ page }), live, FIXTURE_NOW, SHARED))
		expect(section).toContain(
			`By subscribing, you agree to our <a href="https://acme.example/terms" rel="noopener">Terms of service</a>.`,
		)
	})
})

describe("renderSubscriptionPage", () => {
	it("posts the link's token from a button, escaped, under the page's base", () => {
		const html = renderSubscriptionPage(
			makeSnapshot(),
			{
				title: "Unsubscribe",
				text: `Stop <b>emails</b>`,
				icon: "bell-off",
				action: { path: "/unsubscribe", token: `a"><script>`, label: "Unsubscribe" },
			},
			{ basePath: "/s/acme" },
		)
		expect(html).toContain(`<form method="post" action="/s/acme/unsubscribe">`)
		expect(html).toContain(`value="a&quot;&gt;&lt;script&gt;"`)
		expect(html).toContain("Stop &lt;b&gt;emails&lt;/b&gt;")
		expect(html).toContain(`<meta name="robots" content="noindex">`)
		expect(html).toContain(`href="/s/acme/">View status page</a>`)
	})
})
