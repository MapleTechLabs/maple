import { BillingAddress, BillingProfile, BillingTaxId } from "@maple/domain/http"
import { Effect, Exit } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import type { MemberActivity } from "@maple/backend/services/org/OrgMembersService"
import {
	billingOf,
	emailDomainsOf,
	fetchHomepage,
	homepageOf,
	isFetchableHost,
	isFreeMail,
	memberNameWords,
	peopleOf,
	withoutPersonalNames,
} from "./evidence-company"

const DAY_MS = 86_400_000
const CANCELLED_MS = 1_760_000_000_000

describe("billingOf", () => {
	it("keeps the business data and the tax id types, never their numbers", () => {
		const billing = billingOf(
			new BillingProfile({
				linked: true,
				name: "  Acme   Widgets GmbH ",
				address: new BillingAddress({ line1: "Hauptstr. 1", city: "Berlin", country: "de" }),
				taxIds: [
					new BillingTaxId({ id: "txi_1", type: "eu_vat", value: "DE123456789", country: "DE" }),
				],
			}),
		)
		expect(billing).toEqual({
			linked: true,
			name: "Acme Widgets GmbH",
			nameIsPersonal: false,
			country: "DE",
			city: "Berlin",
			taxIds: [{ type: "eu_vat", country: "DE" }],
		})
		expect(JSON.stringify(billing)).not.toContain("DE123456789")
	})

	it("reads an org without a Stripe customer as linked to nothing", () => {
		expect(billingOf(null)).toEqual({
			linked: false,
			name: null,
			nameIsPersonal: false,
			country: null,
			city: null,
			taxIds: [],
		})
	})
})

describe("emailDomainsOf", () => {
	it("ranks company domains and only counts personal, test and Maple staff addresses", () => {
		const domains = emailDomainsOf(
			[
				"a@Acme.io",
				"b@acme.io",
				"c@partner.dev",
				"d@gmail.com",
				"e@proton.me",
				"f@example.com",
				"g@box.test",
				"h+clerk_test@acme.io",
				"support@maple.dev",
				"ops@eu.maple.dev",
				"i@yahoo.com.br",
				"j@users.noreply.github.com",
			].map((email) => ({ email })),
		)
		expect(domains).toEqual({
			company: [
				{ domain: "acme.io", members: 2 },
				{ domain: "partner.dev", members: 1 },
			],
			freeMailMembers: 4,
			testMembers: 5,
		})
		expect(JSON.stringify(domains)).not.toMatch(/gmail|proton/)
	})

	it("shows the five domains with the most members", () => {
		const emails = ["a", "b", "c", "d", "e", "f"].flatMap((name, index) =>
			Array.from({ length: index + 1 }, (_, n) => ({ email: `u${n}@${name}.com` })),
		)
		expect(emailDomainsOf(emails).company.map((entry) => entry.domain)).toEqual([
			"f.com",
			"e.com",
			"d.com",
			"c.com",
			"b.com",
		])
	})
})

describe("isFreeMail", () => {
	it.each([
		"outlook.es",
		"yahoo.com.br",
		"gmx.ch",
		"mail.gmail.com",
		"abc.privaterelay.appleid.com",
		"foxmail.com",
	])("treats %s as free mail", (domain) => {
		expect(isFreeMail(domain)).toBe(true)
	})

	it.each(["live.acme.com", "outlookventures.com", "acme.io"])("treats %s as a company", (domain) => {
		expect(isFreeMail(domain)).toBe(false)
	})
})

describe("withoutPersonalNames", () => {
	const words = memberNameWords(["jane.doe@acme.io", "acme@acme.io", "info@acme.io"], ["Sam Lee"])
	const known = { words, complete: true }
	const billing = billingOf(null)
	const homepage = {
		domain: "acme.io",
		title: "Acme Rockets",
		description: "Rockets for everyone",
		siteName: "Acme",
		redirectedTo: null,
	}

	it("leaves out names that hold a member's first or last name", () => {
		expect(
			withoutPersonalNames(
				{ orgName: "Jane's Org", billing: { ...billing, name: "SAM LEE" }, homepage: null },
				known,
				["acme.io"],
			),
		).toEqual({
			orgName: null,
			orgNameIsPersonal: true,
			billing: { ...billing, name: null, nameIsPersonal: true },
			homepage: null,
		})
	})

	it("keeps a company name, even one matching the domain or a role address", () => {
		expect(
			withoutPersonalNames(
				{ orgName: "Acme Info", billing: { ...billing, name: "Acme GmbH" }, homepage },
				known,
				["acme.io"],
			),
		).toEqual({
			orgName: "Acme Info",
			orgNameIsPersonal: false,
			billing: { ...billing, name: "Acme GmbH" },
			homepage,
		})
	})

	it("keeps a homepage's description but not a title or site name holding a member's name", () => {
		const personal = { ...homepage, title: "Jane Doe — Engineer", siteName: "Sam's notes" }
		expect(
			withoutPersonalNames({ orgName: null, billing: null, homepage: personal }, known, ["acme.io"])
				.homepage,
		).toEqual({ ...homepage, title: null, siteName: null })
	})

	describe("without every member's name", () => {
		const partial = { words: memberNameWords(["js@acme.io"], []), complete: false }

		it("leaves out a Stripe name that matches no company", () => {
			expect(
				withoutPersonalNames(
					{ orgName: "Rocket Team", billing: { ...billing, name: "Jane Smith" }, homepage: null },
					partial,
					["acme.io"],
				).billing,
			).toEqual({ ...billing, name: null, nameIsPersonal: true })
		})

		it.each([
			["the org name", "Rocket Team", "Rocket Labs Ltd"],
			["a company domain", null, "Acme Inc"],
		])("keeps a Stripe name sharing a word with %s", (_, orgName, name) => {
			expect(
				withoutPersonalNames({ orgName, billing: { ...billing, name }, homepage: null }, partial, [
					"acme.io",
				]).billing,
			).toEqual({ ...billing, name })
		})
	})
})

describe("isFetchableHost", () => {
	it.each(["acme.io", "www.acme.co.uk", "xn--bcher-kva.example.de"])("allows %s", (host) => {
		expect(isFetchableHost(host)).toBe(true)
	})

	it.each(["localhost", "intranet", "10.0.0.1", "[::1]", "app.localhost", "acme.internal", "example.com"])(
		"refuses %s",
		(host) => {
			expect(isFetchableHost(host)).toBe(false)
		},
	)
})

describe("homepageOf", () => {
	it("reads the title and meta tags as clean one-line text", () => {
		const html = `<html><head>
			<title>
				Acme &amp; Co &#8211; Rockets
			</title>
			<meta content="Rockets for &quot;everyone&quot;. Write to sales@acme.io" name="description">
			<meta property='og:site_name' content='Acme'>
			<meta property="og:description" content="ignored when a description exists">
		</head></html>`
		expect(homepageOf("acme.io", html, "www.acme.io")).toEqual({
			domain: "acme.io",
			title: "Acme & Co – Rockets",
			description: 'Rockets for "everyone". Write to [email]',
			siteName: "Acme",
			redirectedTo: null,
		})
	})

	it("falls back to og:description, caps text and names a redirect to another domain", () => {
		const html = `<title>${"word ".repeat(100)}</title><meta property="og:description" content="Rockets">`
		const homepage = homepageOf("acme.io", html, "acme-rockets.com")
		expect(homepage.title).toHaveLength(200)
		expect(homepage.description).toBe("Rockets")
		expect(homepage.siteName).toBeNull()
		expect(homepage.redirectedTo).toBe("acme-rockets.com")
	})
})

describe("homepageOf on a hostile page", () => {
	// Each of these took seconds with unbounded patterns; the default test timeout is the bound.
	it.each([
		["one huge meta tag", `<head><meta ${"a".repeat(200_000)}</head>`],
		["unclosed meta tags", `<head>${"<meta a=".repeat(40_000)}</head>`],
		["an unspaced title", `<title>${"a".repeat(200_000)}</title>`],
		["an address-like title", `<title>${"a@b".repeat(70_000)}</title>`],
		["unclosed entities", `<head><title>${"&a".repeat(100_000)}</title></head>`],
		["a long unspaced description", `<meta name="description" content="${"a@b".repeat(600)}">`],
	])("reads %s without blowing up", (_, page) => {
		const homepage = homepageOf("acme.io", page, "acme.io")
		expect((homepage.title ?? "").length).toBeLessThanOrEqual(200)
		expect((homepage.description ?? "").length).toBeLessThanOrEqual(200)
	})
})

describe("peopleOf", () => {
	const member = (role: string, joinedDaysAgo: number, seenDaysAgo: number | null): MemberActivity => ({
		role,
		joinedAtMs: CANCELLED_MS - joinedDaysAgo * DAY_MS,
		lastSignInAtMs: seenDaysAgo === null ? null : CANCELLED_MS - seenDaysAgo * DAY_MS,
		lastActiveAtMs: null,
		name: null,
	})

	it("counts joins and recent activity relative to the cancellation", () => {
		expect(
			peopleOf(CANCELLED_MS, [
				member("org:admin", 200, 1),
				member("org:member", 20, 20),
				member("org:member", 5, null),
				{ ...member("org:member", 90, 60), lastActiveAtMs: CANCELLED_MS - 3 * DAY_MS },
			]),
		).toEqual({
			members: 4,
			admins: 1,
			joinedLast30Days: 2,
			firstJoinedDaysBeforeCancel: 200,
			latestJoinedDaysBeforeCancel: 5,
			activeLast14Days: 2,
			activeLast30Days: 3,
			lastActiveDaysBeforeCancel: 1,
		})
	})

	it("does not count activity after the cancellation", () => {
		const afterCancel = (days: number) => CANCELLED_MS + days * DAY_MS
		expect(
			peopleOf(CANCELLED_MS, [
				{ ...member("org:member", 40, null), lastActiveAtMs: afterCancel(2) },
				{ ...member("org:member", 40, 20), lastActiveAtMs: afterCancel(2) },
				{ ...member("org:member", -3, null), lastSignInAtMs: afterCancel(3) },
			]),
		).toMatchObject({
			members: 3,
			joinedLast30Days: 0,
			latestJoinedDaysBeforeCancel: 40,
			activeLast14Days: 0,
			activeLast30Days: 1,
			lastActiveDaysBeforeCancel: 20,
		})
	})

	it("has no join or activity days without members", () => {
		expect(peopleOf(CANCELLED_MS, [])).toMatchObject({
			members: 0,
			firstJoinedDaysBeforeCancel: null,
			lastActiveDaysBeforeCancel: null,
		})
	})
})

interface Route {
	readonly status: number
	readonly body?: string
	readonly location?: string
	readonly contentType?: string
}

/** Answers each URL from `routes`, 404 otherwise, and records what was asked for. */
const stubClient = (routes: Readonly<Record<string, Route>>) => {
	const requested: Array<string> = []
	const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
		requested.push(request.url)
		const route = routes[request.url] ?? { status: 404 }
		const headers = new Headers({ "content-type": route.contentType ?? "text/html; charset=utf-8" })
		if (route.location !== undefined) headers.set("location", route.location)
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new Response(route.body ?? null, { status: route.status, headers }),
			),
		)
	})
	return { client, requested }
}

describe("fetchHomepage", () => {
	it("follows a redirect to another domain and names it", async () => {
		const { client } = stubClient({
			"https://acme.io/": { status: 301, location: "https://www.acme-rockets.com/" },
			"https://www.acme-rockets.com/": { status: 200, body: "<title>Acme Rockets</title>" },
		})
		const homepage = await Effect.runPromise(fetchHomepage(client, "acme.io"))
		expect(homepage).toMatchObject({ title: "Acme Rockets", redirectedTo: "www.acme-rockets.com" })
	})

	it("refuses a redirect to a private address without requesting it", async () => {
		const { client, requested } = stubClient({
			"https://acme.io/": { status: 302, location: "http://169.254.169.254/latest" },
		})
		const exit = await Effect.runPromiseExit(fetchHomepage(client, "acme.io"))
		expect(Exit.isFailure(exit)).toBe(true)
		expect(requested).toEqual(["https://acme.io/"])
	})

	it("fails on an error page", async () => {
		const { client } = stubClient({ "https://acme.io/": { status: 503, body: "<title>Down</title>" } })
		const exit = await Effect.runPromiseExit(fetchHomepage(client, "acme.io"))
		expect(Exit.isFailure(exit)).toBe(true)
	})

	it("fails on something other than an HTML page", async () => {
		const { client } = stubClient({
			"https://acme.io/": { status: 200, body: "<title>x</title>", contentType: "application/json" },
		})
		const exit = await Effect.runPromiseExit(fetchHomepage(client, "acme.io"))
		expect(Exit.isFailure(exit)).toBe(true)
	})

	it("refuses a redirect to Maple's own domain", async () => {
		const { client, requested } = stubClient({
			"https://acme.io/": { status: 302, location: "https://app.maple.dev/" },
		})
		const exit = await Effect.runPromiseExit(fetchHomepage(client, "acme.io"))
		expect(Exit.isFailure(exit)).toBe(true)
		expect(requested).toEqual(["https://acme.io/"])
	})
})
