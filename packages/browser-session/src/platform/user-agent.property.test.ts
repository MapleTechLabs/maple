import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { isLikelyBot, parseUserAgent } from "./user-agent"

const BROWSERS = ["Edge", "Opera", "Samsung Internet", "Chrome", "Firefox", "Safari", "Unknown"]
const OSES = ["Windows", "iOS", "macOS", "Android", "ChromeOS", "Linux", "Unknown"]
const DEVICES = ["mobile", "tablet", "desktop"]

/** Real browsers, which must never lose their replay to the crawler gate. */
const PEOPLE = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
	"Mozilla/5.0 (Linux; Android 10; CUBOT NOTE 20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
	"Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
	"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
	"Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0",
]

const CRAWLERS = [
	"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
	"Mozilla/5.0 (compatible; YandexRenderResourcesBot/1.0; +http://yandex.com/bots) AppleWebKit/537.36",
	"Mozilla/5.0 (compatible; Baiduspider-render/2.0; +http://www.baidu.com/search/spider.html)",
	"Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
	"Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
	"facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
]

describe("parseUserAgent", () => {
	it("maps any string onto the closed set of facet values", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.string({ unit: "binary" }), fc.constantFrom(...PEOPLE, ...CRAWLERS)),
				(ua) => {
					const parsed = parseUserAgent(ua)
					expect(BROWSERS).toContain(parsed.browserName)
					expect(OSES).toContain(parsed.osName)
					expect(DEVICES).toContain(parsed.deviceType)
				},
			),
		)
	})

	it("recognizes the OS of every real-browser UA", () => {
		// Not the browser: an in-app iOS webview carries no browser token at all.
		for (const ua of PEOPLE) expect(parseUserAgent(ua).osName).not.toBe("Unknown")
	})
})

describe("isLikelyBot", () => {
	it("is false for every real browser, with or without extra product tokens", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...PEOPLE),
				fc.stringMatching(/^( [A-Za-z]{2,12}\/[0-9.]{1,6})?$/),
				(ua, extra) => {
					expect(isLikelyBot(`${ua}${extra}`)).toBe(false)
				},
			),
		)
	})

	it("is true for every crawler, whatever its casing", () => {
		fc.assert(
			fc.property(fc.constantFrom(...CRAWLERS), fc.boolean(), (ua, upper) => {
				expect(isLikelyBot(upper ? ua.toUpperCase() : ua)).toBe(true)
			}),
		)
	})

	it("ignores case for any string", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), (ua) => {
				expect(isLikelyBot(ua)).toBe(isLikelyBot(ua.toLowerCase()))
			}),
		)
	})
})
