import { FIXTURE_PAGE_ID, fixtureComponentId, makeSnapshot } from "@maple/status-page/fixtures"
import { Effect, Option, Array as Arr } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { apiSubscriptions } from "./subscribe"
import { type FakeStorage, makeFakeStorage, postForm, publish, send } from "./test-support"

const SHARED = "https://status.maple.workers.dev/s/acme"

describe("subscribing from the page", () => {
	let fake: FakeStorage
	beforeEach(() => {
		fake = makeFakeStorage()
		publish(fake, makeSnapshot())
	})

	it("forwards the address and the picked components, and tells the visitor to check their inbox", async () => {
		const response = await send(
			fake,
			postForm(`${SHARED}/subscribe`, [
				["email", " ana@example.com "],
				["scope", "some"],
				["componentIds", fixtureComponentId(1)],
			]),
		)
		expect(response.status).toBe(200)
		expect(response.headers.get("cache-control")).toBe("no-store")
		const html = await response.text()
		expect(html).toContain("Check your inbox")
		expect(html).toContain(`href="/s/acme/"`)
		expect(fake.subscriptionCalls).toEqual([
			{
				action: "subscribe",
				pageId: FIXTURE_PAGE_ID,
				input: { email: "ana@example.com", componentIds: [fixtureComponentId(1)] },
			},
		])
	})

	it("ignores ticked components when the visitor chose all of them", async () => {
		await send(
			fake,
			postForm(`${SHARED}/subscribe`, [
				["email", "ana@example.com"],
				["scope", "all"],
				["componentIds", fixtureComponentId(1)],
			]),
		)
		expect(Arr.map(fake.subscriptionCalls, (call) => call.input)).toEqual([
			{ email: "ana@example.com", componentIds: null },
		])
	})

	it("shows Maple's reason for a refusal, and says when subscribing is unavailable", async () => {
		fake.subscriptionOutcome.next = { _tag: "rejected", message: "Enter a valid email address." }
		const rejected = await send(fake, postForm(`${SHARED}/subscribe`, [["email", "nope"]]))
		expect(rejected.status).toBe(400)
		expect(await rejected.text()).toContain("Enter a valid email address.")

		fake.subscriptionOutcome.next = { _tag: "unavailable" }
		const unavailable = await send(fake, postForm(`${SHARED}/subscribe`, [["email", "ana@example.com"]]))
		expect(unavailable.status).toBe(503)

		fake.subscriptionOutcome.next = { _tag: "not-found" }
		expect(
			(await send(fake, postForm(`${SHARED}/subscribe`, [["email", "ana@example.com"]]))).status,
		).toBe(404)
	})

	it("refuses a visitor over the rate limit without asking Maple", async () => {
		fake.limits.allow = false
		const response = await send(fake, postForm(`${SHARED}/subscribe`, [["email", "ana@example.com"]]))
		expect(response.status).toBe(429)
		expect(fake.subscriptionCalls).toEqual([])
		expect(fake.limits.keys).toEqual([`subscribe:203.0.113.7:${FIXTURE_PAGE_ID}`])
	})

	it("sends a plain visit to the form on the page", async () => {
		const response = await send(fake, `${SHARED}/subscribe`)
		expect(response.status).toBe(303)
		expect(response.headers.get("location")).toBe("/s/acme/#subscribe")
	})
})

describe("links from the emails", () => {
	let fake: FakeStorage
	beforeEach(() => {
		fake = makeFakeStorage()
		publish(fake, makeSnapshot())
	})

	it("only shows a confirm button on GET, and confirms on its POST", async () => {
		const shown = await send(fake, `${SHARED}/subscribe/confirm?token=tok-1`)
		expect(shown.status).toBe(200)
		const html = await shown.text()
		expect(html).toContain(`action="/s/acme/subscribe/confirm"`)
		expect(html).toContain(`name="token" value="tok-1"`)
		expect(fake.subscriptionCalls).toEqual([])

		const confirmed = await send(fake, postForm(`${SHARED}/subscribe/confirm`, [["token", "tok-1"]]))
		expect(confirmed.status).toBe(200)
		expect(await confirmed.text()).toContain("You are subscribed")
		expect(fake.subscriptionCalls).toEqual([
			{ action: "confirm", pageId: FIXTURE_PAGE_ID, input: "tok-1" },
		])
	})

	it("says when a confirmation link has expired", async () => {
		fake.subscriptionOutcome.next = {
			_tag: "rejected",
			message: "This confirmation link has expired or was already used.",
		}
		const response = await send(fake, postForm(`${SHARED}/subscribe/confirm`, [["token", "old"]]))
		expect(response.status).toBe(400)
		expect(await response.text()).toContain("expired or was already used")
	})

	it("unsubscribes on a mail client's one-click POST, token in the query", async () => {
		const response = await send(
			fake,
			postForm(`${SHARED}/unsubscribe?token=tok-2`, [["List-Unsubscribe", "One-Click"]]),
		)
		expect(response.status).toBe(200)
		expect(await response.text()).toContain("You are unsubscribed")
		expect(fake.subscriptionCalls).toEqual([
			{ action: "unsubscribe", pageId: FIXTURE_PAGE_ID, input: "tok-2" },
		])
	})

	it("refuses a link without a token", async () => {
		expect((await send(fake, `${SHARED}/unsubscribe`)).status).toBe(400)
		expect((await send(fake, `${SHARED}/subscribe/confirm`)).status).toBe(400)
		expect(fake.subscriptionCalls).toEqual([])
	})
})

describe("apiSubscriptions", () => {
	const answering = (status: number, body: string | null = null) => {
		const requests: Array<{ readonly url: string; readonly body: string }> = []
		const subscriptions = apiSubscriptions(
			Option.some({
				fetch: async (input: string, init?: RequestInit) => {
					requests.push({ url: input, body: typeof init?.body === "string" ? init.body : "" })
					return new Response(body, { status })
				},
			}),
		)
		return { subscriptions, requests }
	}

	it("posts JSON to the page's public endpoint, leaving out the components for all of them", async () => {
		const { subscriptions, requests } = answering(204)
		const outcome = await Effect.runPromise(
			subscriptions.subscribe(FIXTURE_PAGE_ID, { email: "ana@example.com", componentIds: null }),
		)
		expect(outcome).toEqual({ _tag: "ok" })
		expect(requests).toEqual([
			{
				url: `https://maple-api.internal/api/status-pages/public/${FIXTURE_PAGE_ID}/subscribe`,
				body: `{"email":"ana@example.com"}`,
			},
		])
	})

	it("passes a refusal's message on, and reads anything else as not found or unavailable", async () => {
		const run = (status: number, body: string | null = null) =>
			Effect.runPromise(answering(status, body).subscriptions.confirm(FIXTURE_PAGE_ID, "t"))
		expect(await run(400, `{"_tag":"x","message":"Link expired."}`)).toEqual({
			_tag: "rejected",
			message: "Link expired.",
		})
		expect(await run(404)).toEqual({ _tag: "not-found" })
		expect(await run(503)).toEqual({ _tag: "unavailable" })
		expect(
			await Effect.runPromise(apiSubscriptions(Option.none()).unsubscribe(FIXTURE_PAGE_ID, "t")),
		).toEqual({
			_tag: "unavailable",
		})
	})
})
