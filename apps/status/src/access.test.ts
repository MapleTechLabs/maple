import {
	hashStatusPagePassword,
	signStatusPageAccess,
	STATUS_PAGE_ACCESS_MAX_AGE_SECONDS,
} from "@maple/domain/status-page-access"
import type { StatusPageSnapshot } from "@maple/domain/status-page"
import { FIXTURE_NOW, FIXTURE_PAGE_ID, makeSnapshot } from "@maple/status-page/fixtures"
import { Effect, Option, String as Str } from "effect"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type FakeStorage, makeFakeStorage, postForm, publish, send } from "./test-support"

const PAGE = "https://status.acme.example/"
const PASSWORD = "correct horse battery"
const DAY_MS = 86_400_000

const withAccess = (
	visibility: StatusPageSnapshot["page"]["visibility"],
	passwordHash: string | null,
): StatusPageSnapshot => {
	const snapshot = makeSnapshot()
	return { ...snapshot, page: { ...snapshot.page, visibility }, passwordHash }
}

/** The `name=value` pair of a Set-Cookie header, ready to send back as a Cookie header. */
const cookiePair = (response: Response): string =>
	Option.getOrThrow(
		Option.fromNullishOr(response.headers.get("set-cookie")).pipe(
			Option.flatMap(Str.match(/^([^;]+)/u)),
			Option.flatMapNullishOr((found) => found[1]),
		),
	)

const withCookie = (url: string, cookie: string) => new Request(url, { headers: { cookie } })

let hash = ""
let otherHash = ""
beforeAll(async () => {
	hash = await Effect.runPromise(hashStatusPagePassword(PASSWORD))
	otherHash = await Effect.runPromise(hashStatusPagePassword("a different password"))
})

describe("a password-protected page", () => {
	let fake: FakeStorage
	beforeEach(() => {
		fake = makeFakeStorage()
		publish(fake, withAccess("password", hash))
	})

	it("shows only its password form until the password is entered", async () => {
		const response = await send(fake, PAGE)
		const html = await response.text()
		expect(response.status).toBe(401)
		expect(html).toContain('action="/_access"')
		expect(html).toContain('<meta name="robots" content="noindex">')
		expect(html).not.toContain("Dashboard")
		expect(response.headers.get("cache-control")).toBe("private, no-store")
		expect(response.headers.get("x-robots-tag")).toBe("noindex")
	})

	it("keeps feeds, status.json, the badge and break-glass behind the password", async () => {
		for (const path of ["feed.atom", "feed.rss", "api/v1/status.json", "badge.svg", "_manage"]) {
			const response = await send(fake, `${PAGE}${path}`)
			expect(response.status, path).toBe(401)
			expect(await response.text(), path).toBe("This status page is password-protected.")
		}
	})

	it("refuses a wrong password without setting a cookie", async () => {
		const response = await send(fake, postForm(`${PAGE}_access`, [["password", "not the password"]]))
		expect(response.status).toBe(401)
		expect(response.headers.get("set-cookie")).toBeNull()
		expect(await response.text()).toContain("That password is not right")
	})

	it("lets the visitor in for 30 days with the right password, without feeds or subscribe options", async () => {
		const login = await send(fake, postForm(`${PAGE}_access`, [["password", PASSWORD]]))
		expect(login.status).toBe(303)
		expect(login.headers.get("location")).toBe("/")
		const setCookie = login.headers.get("set-cookie") ?? ""
		for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=2592000"]) {
			expect(setCookie).toContain(attribute)
		}
		const cookie = cookiePair(login)

		const page = await send(fake, withCookie(PAGE, cookie))
		const html = await page.text()
		expect(page.status).toBe(200)
		expect(html).toContain("Dashboard")
		expect(html).not.toContain("Subscribe to updates")
		expect(html).not.toContain("feed.atom")
		expect(html).toContain('<meta name="robots" content="noindex">')
		expect(page.headers.get("cache-control")).toBe("private, no-store")

		const json = await send(fake, withCookie(`${PAGE}api/v1/status.json`, cookie))
		expect(json.status).toBe(200)

		const later = FIXTURE_NOW + 29 * DAY_MS
		expect((await send(fake, withCookie(PAGE, cookie), { nowMs: later })).status).toBe(200)
	})

	it("scopes the cookie to the page's path on Maple's shared host", async () => {
		const login = await send(
			fake,
			postForm("https://status.maple.workers.dev/s/acme/_access", [["password", PASSWORD]]),
		)
		expect(login.headers.get("location")).toBe("/s/acme/")
		expect(login.headers.get("set-cookie")).toContain("Path=/s/acme;")
	})

	it("asks again once the cookie expires", async () => {
		const cookie = cookiePair(await send(fake, postForm(`${PAGE}_access`, [["password", PASSWORD]])))
		const expired = FIXTURE_NOW + STATUS_PAGE_ACCESS_MAX_AGE_SECONDS * 1000 + 1
		expect((await send(fake, withCookie(PAGE, cookie), { nowMs: expired })).status).toBe(401)
	})

	it("refuses forged cookies: a changed signature, another page's, or one issued for too long", async () => {
		const cookie = cookiePair(await send(fake, postForm(`${PAGE}_access`, [["password", PASSWORD]])))
		const [name, value = ""] = Str.split("=")(cookie)
		const [expires, signature = ""] = Str.split(".")(value)
		const flipped = `${Str.startsWith("A")(signature) ? "B" : "A"}${Str.slice(1)(signature)}`
		const otherPage = await Effect.runPromise(
			signStatusPageAccess(hash, "00000000-0000-4000-8000-000000000000", FIXTURE_NOW + DAY_MS),
		)
		const tooLong = await Effect.runPromise(
			signStatusPageAccess(hash, FIXTURE_PAGE_ID, FIXTURE_NOW + 365 * DAY_MS),
		)
		for (const forged of [
			`${expires}.${flipped}`,
			`${Number(expires) + 1}.${signature}`,
			otherPage,
			tooLong,
			"",
		]) {
			expect((await send(fake, withCookie(PAGE, `${name}=${forged}`))).status, forged).toBe(401)
		}
	})

	it("signs everyone out when the password changes", async () => {
		const cookie = cookiePair(await send(fake, postForm(`${PAGE}_access`, [["password", PASSWORD]])))
		publish(fake, withAccess("password", otherHash))
		fake.cache.clear()
		expect((await send(fake, withCookie(PAGE, cookie))).status).toBe(401)
		const attempt = await send(fake, postForm(`${PAGE}_access`, [["password", PASSWORD]]))
		expect(attempt.status).toBe(401)
	})

	it("stops checking passwords once the address is rate-limited, even the right one", async () => {
		fake.limits.allow = false
		const response = await send(fake, postForm(`${PAGE}_access`, [["password", PASSWORD]]))
		expect(response.status).toBe(429)
		expect(response.headers.get("set-cookie")).toBeNull()
		expect(fake.limits.keys).toEqual([`access:203.0.113.7:${FIXTURE_PAGE_ID}`])
	})
})

describe("an internal page", () => {
	let fake: FakeStorage
	beforeEach(() => {
		fake = makeFakeStorage()
		publish(fake, withAccess("internal", null))
	})

	it("is not found on its custom domain, its Maple address or any of its paths", async () => {
		for (const url of [
			PAGE,
			`${PAGE}feed.rss`,
			`${PAGE}api/v1/status.json`,
			`${PAGE}badge.svg`,
			`${PAGE}_manage`,
			"https://status.maple.workers.dev/s/acme/",
			"https://status.maple.workers.dev/s/acme/feed.atom",
		]) {
			const response = await send(fake, url)
			expect(response.status, url).toBe(404)
			expect(await response.text(), url).not.toContain("Dashboard")
		}
	})
})
