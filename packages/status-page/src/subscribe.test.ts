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

/** The header's subscribe menu, up to its closing tag. */
const panel = (html: string): string =>
	between(between(html, "<header", "</header>"), "<details", "</details>")

describe("the subscribe menu", () => {
	it("opens from the header and offers email with a pick of the page's components, the feeds, and a Slack command", () => {
		const snapshot = makeSnapshot()
		const html = renderPage(snapshot, live, FIXTURE_NOW, SHARED)
		const section = panel(html)

		expect(section).toContain("<summary>Subscribe to updates</summary>")
		expect(section).toContain(`<form method="post" action="/s/acme/subscribe">`)
		expect(section).toContain(`name="scope" value="all" checked`)
		expect(
			Arr.map(
				Arr.fromIterable(Str.matchAll(/name="componentIds" value="([^"]+)"/gu)(section)),
				(match) => match[1],
			),
		).toEqual(Arr.map(snapshot.components, (component) => component.id))
		expect(section).toContain(`href="/s/acme/feed.rss"`)
		expect(section).toContain(`href="/s/acme/feed.atom"`)
		expect(section).toContain(
			"<code>/feed subscribe https://status.maple.workers.dev/s/acme/feed.rss</code>",
		)
		expect(section).toContain(
			`data-copy="/feed subscribe https://status.maple.workers.dev/s/acme/feed.rss"`,
		)
	})

	it("is the page's only subscribe surface: no section of its own, no in-page link to one", () => {
		const html = renderPage(makeSnapshot(), live, FIXTURE_NOW, SHARED)
		expect(html).not.toContain("#subscribe")
		expect(html).not.toContain("Get updates")
		expect(Str.split(`name="email"`)(html)).toHaveLength(2)
	})

	it("leaves out the Slack command when the page's public address is unknown", () => {
		const section = panel(renderPage(makeSnapshot(), live, FIXTURE_NOW, { basePath: "/s/acme" }))
		expect(section).not.toContain("/feed subscribe")
		expect(section).toContain(`href="/s/acme/feed.rss"`)
	})

	it("asks only for an address on a page without components", () => {
		const section = panel(renderPage(makeSnapshot({ components: [] }), live, FIXTURE_NOW, SHARED))
		expect(section).toContain(`name="email"`)
		expect(section).not.toContain(`name="scope"`)
		expect(section).not.toContain(fixtureComponentId(0))
	})
})

describe("renderSubscriptionPage", () => {
	it("posts the link's token from a button, escaped, under the page's base", () => {
		const html = renderSubscriptionPage(
			makeSnapshot(),
			{
				title: "Unsubscribe",
				text: `Stop <b>emails</b>`,
				tone: "ok",
				action: { path: "/unsubscribe", token: `a"><script>`, label: "Unsubscribe" },
			},
			{ basePath: "/s/acme" },
		)
		expect(html).toContain(`<form method="post" action="/s/acme/unsubscribe">`)
		expect(html).toContain(`value="a&quot;&gt;&lt;script&gt;"`)
		expect(html).toContain("Stop &lt;b&gt;emails&lt;/b&gt;")
		expect(html).toContain(`<meta name="robots" content="noindex">`)
	})
})
