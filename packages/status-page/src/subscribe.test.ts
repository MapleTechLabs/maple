import type { StatusPageFreshness } from "@maple/domain/status-page"
import { Array as Arr, Option, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { FIXTURE_NOW, makeSnapshot } from "./fixtures"
import { renderPage } from "./index"

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

describe("the subscribe dialog", () => {
	it("opens from the header's link, with or without script", () => {
		const html = renderPage(makeSnapshot(), live, FIXTURE_NOW, SHARED)
		expect(between(html, "<header", "</header>")).toContain(`href="#subscribe">Subscribe to updates</a>`)
		expect(dialog(html)).toContain(`role="dialog"`)
	})

	it("opens on the RSS tab, with the feeds at the page's address and a Slack command", () => {
		const section = dialog(renderPage(makeSnapshot(), live, FIXTURE_NOW, SHARED))
		expect(section).toContain(`id="sub-rss" class="sr" checked`)
		expect(section).toContain(`value="https://status.maple.workers.dev/s/acme/feed.rss"`)
		expect(section).toContain(`value="https://status.maple.workers.dev/s/acme/feed.atom"`)
		expect(section).toContain(`value="/feed subscribe https://status.maple.workers.dev/s/acme/feed.rss"`)
	})

	it("asks for no email address", () => {
		const html = renderPage(makeSnapshot(), live, FIXTURE_NOW, SHARED)
		expect(html).not.toContain(`type="email"`)
	})

	it("leaves out the Slack command when the page's public address is unknown, and links the feeds under its base", () => {
		const section = dialog(renderPage(makeSnapshot(), live, FIXTURE_NOW, { basePath: "/s/acme" }))
		expect(section).not.toContain("/feed subscribe")
		expect(section).toContain(`value="/s/acme/feed.rss"`)
	})
})
