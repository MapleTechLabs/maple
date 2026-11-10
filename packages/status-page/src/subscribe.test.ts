import type { StatusPageFreshness } from "@maple/domain/status-page"
import { Array as Arr, Option, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { FIXTURE_NOW, fixtureComponentId, makeSnapshot } from "./fixtures"
import { renderPage, renderSubscriptionPage } from "./index"

const live: StatusPageFreshness = { _tag: "live", updatedAt: FIXTURE_NOW - 60_000 }
const SHARED = { basePath: "/s/acme", origin: "https://status.maple.workers.dev" }

/** The panel's markup, up to its closing tag. */
const panel = (html: string): string =>
	Option.match(Arr.get(Str.split(`<section class="panel subscribe"`)(html), 1), {
		onNone: () => "",
		onSome: (after) => Str.split("</section>")(after)[0] ?? "",
	})

describe("the subscribe panel", () => {
	it("offers email with a pick of the page's components, the feeds, and a Slack command", () => {
		const snapshot = makeSnapshot()
		const html = renderPage(snapshot, live, FIXTURE_NOW, SHARED)
		const section = panel(html)

		expect(html).toContain(`<a class="site" href="#subscribe">Subscribe to updates</a>`)
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
