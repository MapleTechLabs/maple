// Product-event funnels against a real ClickHouse engine (chDB), over example products.
//
// Every expectation comes from the reference funnel in `funnel-scenarios-support.ts`, a plain
// TypeScript walk of the same rows. The compiled SQL has to agree with it person for person, so a
// funnel that double-counts, loses the row order inside a millisecond or reports a time for a
// chain it did not count fails here on realistic data rather than in someone's dashboard.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as CH from "@maple/query-engine/ch"
import { Array as Arr } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { describeWithChdb } from "./libchdb-test-support"
import { contentSite, mobileOnboarding, saasSignup, shopCheckout } from "./funnel-scenarios"
import {
	type Dataset,
	DAY_MS,
	event,
	HOUR_MS,
	insertDataset,
	MINUTE_MS,
	referenceBreakdown,
	referenceFunnel,
	referenceLeavers,
	referenceTiming,
	seeded,
	session,
	type SimEvent,
	type StepTiming,
	sqlBreakdown,
	sqlFunnel,
	sqlLeavers,
	sqlTiming,
} from "./funnel-scenarios-support"

type Opts = CH.ProductEventsFunnelOpts

const ev = (eventName: string, attributeEquals?: Record<string, string>): CH.FunnelStep =>
	attributeEquals === undefined
		? { kind: "event", eventName }
		: { kind: "event", eventName, attributeEquals }
const page = (pagePath: string, host?: string): CH.FunnelStep =>
	host === undefined ? { kind: "page", pagePath } : { kind: "page", pagePath, host }

/** The random tests run hundreds of queries; a CI runner takes about three times a laptop. */
const RANDOM_TEST_TIMEOUT_MS = 120_000

const KEYS: ReadonlyArray<CH.FunnelKeyBy> = ["person", "visitor", "user", "session"]

/** One person's span is both quantiles. */
const both = (ms: number) => ({ p50Ms: ms, p90Ms: ms })
const sinceStart = (ms: number) => ({ sinceStartP50Ms: ms, sinceStartP90Ms: ms })

// Hand-built cases: one person each, in their own org, so a wrong count names its cause.

const user = (userId: string, rows: ReadonlyArray<readonly [atMs: number, name: string, seq?: number]>) =>
	Arr.map(rows, ([atMs, eventName, seq]) =>
		event({ atMs, eventName, userId, source: "server", seq: seq ?? 0 }),
	)

const CASES = {
	// A did the event once, B twice, C three times.
	repeats: [
		...user("once", [[1_000, "search"]]),
		...user("twice", [
			[1_000, "search"],
			[5_000, "search"],
		]),
		...user("thrice", [
			[1_000, "search"],
			[5_000, "search"],
			[9_000, "search"],
		]),
	],
	// Two rows in one millisecond, told apart by `seq` alone.
	sameMillisecond: [
		...user("in_order", [
			[1_000, "cart", 0],
			[1_000, "pay", 1],
		]),
		...user("reversed", [
			[1_000, "pay", 0],
			[1_000, "cart", 1],
		]),
	],
	// The second step lands exactly on the one-hour window, and one millisecond past it.
	windowEdge: [
		...user("on_edge", [
			[0, "start"],
			[HOUR_MS, "finish"],
		]),
		...user("past_edge", [
			[0, "start"],
			[HOUR_MS + 1, "finish"],
		]),
		// The same two, with `seq` pulling the other way: the window measures time, not `seq`.
		...user("on_edge_later_seq", [
			[0, "start", 0],
			[HOUR_MS, "finish", 900],
		]),
		...user("past_edge_earlier_seq", [
			[0, "start", 900],
			[HOUR_MS + 1, "finish", 0],
		]),
	],
	// Gave up, came back three hours later and went all the way: only the second run fits an hour.
	restart: user("returner", [
		[0, "start"],
		[10 * MINUTE_MS, "middle"],
		[3 * HOUR_MS, "start"],
		[3 * HOUR_MS + 5 * MINUTE_MS, "middle"],
		[3 * HOUR_MS + 20 * MINUTE_MS, "finish"],
		[3 * HOUR_MS + 21 * MINUTE_MS, "settings_opened"],
	]),
	// Later steps before the first one do not count.
	outOfOrder: [
		...user("backwards", [
			[1_000, "finish"],
			[2_000, "middle"],
			[3_000, "start"],
		]),
		...user("forwards", [
			[1_000, "start"],
			[2_000, "middle"],
			[3_000, "finish"],
		]),
	],
	// One account firing the same event four thousand times, then checking out.
	// A backend that sends two events in one request: same millisecond, and no `seq` to order them.
	tiedServerEvents: [
		...user("signup_first", [
			[1_000, "signup"],
			[1_000, "plan"],
			[9_000, "later"],
		]),
		...user("plan_first", [
			[1_000, "plan"],
			[1_000, "signup"],
			[9_000, "later"],
		]),
		...user("searched_twice", [
			[1_000, "search"],
			[1_000, "search"],
			[9_000, "later"],
		]),
	],
	// A long session: the page view and the event it fires share a millisecond across `seq` 1024.
	longSession: user("clicker", [
		[1_000, "cart", 1_023],
		[1_000, "pay", 1_024],
	]),
	heavyRepeats: [
		...Arr.makeBy(4_000, (index) =>
			event({ atMs: index * 1_000, eventName: "search", userId: "crawler", source: "server" }),
		),
		event({ atMs: 4_000 * 1_000, eventName: "checkout", userId: "crawler", source: "server" }),
	],
	// Names and values that would break a query built by string concatenation.
	awkwardNames: [
		event({
			atMs: 1_000,
			userId: "poet",
			source: "server",
			eventName: 'it\'s "quoted" \\ back',
			attributes: { "plan's": "pro' OR '1'='1" },
		}),
		event({ atMs: 2_000, userId: "poet", source: "server", eventName: "bestellt · 注文 🎉" }),
		event({
			atMs: 1_000,
			userId: "plain",
			source: "server",
			eventName: 'it\'s "quoted" \\ back',
			attributes: { "plan's": "free" },
		}),
	],
} satisfies Record<string, ReadonlyArray<SimEvent>>

const caseDataset = (name: keyof typeof CASES): Dataset => ({
	orgId: `case_${name}`,
	events: CASES[name],
	sessions: [],
})

const view = (visitorId: string, atMs: number, seq: number) =>
	event({
		atMs,
		seq,
		sessionId: `s_${visitorId}`,
		visitorId,
		kind: "navigation",
		eventName: "$pageview",
		pagePath: "/pricing",
		host: "acme.dev",
	})

// One visitor saw the pricing page once, another twice.
const VIEWS: Dataset = {
	orgId: "case_views",
	sessions: [],
	events: [view("once", 1_000, 0), view("twice", 1_000, 0), view("twice", 60_000, 1)],
}

// Two campaign sessions starting in the same millisecond: one opens with a page view, one sends nothing.
const ENTRIES: Dataset = {
	orgId: "case_entries",
	sessions: [
		session({ sessionId: "e1", startMs: 5_000, visitorId: "reader", utmSource: "twitter" }),
		session({ sessionId: "e2", startMs: 5_000, visitorId: "bouncer", utmSource: "twitter" }),
	],
	events: [
		event({
			atMs: 5_000,
			sessionId: "e1",
			visitorId: "reader",
			kind: "navigation",
			eventName: "$pageview",
			pagePath: "/",
		}),
		event({ atMs: 8_000, seq: 1, sessionId: "e1", visitorId: "reader", eventName: "clicked_cta" }),
	],
}

// A person who arrives from a campaign, signs up in a second session, and is filtered by country.
const ACQUISITION: Dataset = {
	orgId: "case_acquisition",
	sessions: [
		session({ sessionId: "a1", startMs: 0, visitorId: "ann", utmSource: "twitter", country: "DE" }),
		session({ sessionId: "a2", startMs: DAY_MS, visitorId: "ann", userId: "u_ann", country: "DE" }),
		session({ sessionId: "b1", startMs: HOUR_MS, visitorId: "bob", utmSource: "twitter", country: "US" }),
		session({
			sessionId: "c1",
			startMs: 2 * HOUR_MS,
			visitorId: "cy",
			utmSource: "newsletter",
			country: "DE",
		}),
	],
	events: [
		event({
			atMs: 1_000,
			sessionId: "a1",
			visitorId: "ann",
			kind: "navigation",
			eventName: "$pageview",
			pagePath: "/",
			host: "acme.dev",
		}),
		event({
			atMs: DAY_MS + 1_000,
			sessionId: "a2",
			visitorId: "ann",
			userId: "u_ann",
			eventName: "signup_started",
		}),
		event({
			atMs: DAY_MS + 60_000,
			userId: "u_ann",
			source: "server",
			eventName: "plan_started",
			attributes: { plan: "pro" },
		}),
		event({
			atMs: HOUR_MS + 1_000,
			sessionId: "b1",
			visitorId: "bob",
			kind: "navigation",
			eventName: "$pageview",
			pagePath: "/",
			host: "acme.dev",
		}),
		event({ atMs: HOUR_MS + 9_000, sessionId: "b1", visitorId: "bob", eventName: "signup_started" }),
		event({
			atMs: 2 * HOUR_MS + 1_000,
			sessionId: "c1",
			visitorId: "cy",
			kind: "navigation",
			eventName: "$pageview",
			pagePath: "/",
			host: "acme.dev",
		}),
	],
}

describeWithChdb("product event funnels over example products", () => {
	let root = ""
	let db: Chdb
	const saas = saasSignup()
	const shop = shopCheckout()
	const mobile = mobileOnboarding()
	const content = contentSite()
	const random = randomDatasets(40)

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-funnel-scenarios-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		Arr.forEach(
			[
				saas,
				shop,
				mobile,
				content,
				ACQUISITION,
				VIEWS,
				ENTRIES,
				...Arr.map(
					[
						"repeats",
						"sameMillisecond",
						"windowEdge",
						"restart",
						"outOfOrder",
						"awkwardNames",
						"heavyRepeats",
						"tiedServerEvents",
						"longSession",
					] as const,
					caseDataset,
				),
				...Arr.map(random, (entry) => entry.dataset),
			],
			(dataset) => insertDataset(db, dataset),
		)
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	const counts = (dataset: Dataset, opts: Opts) => sqlFunnel(db, dataset.orgId, opts)
	const byUser = (steps: ReadonlyArray<CH.FunnelStep>, windowSeconds = 3_600): Opts => ({
		steps,
		keyBy: "user",
		windowSeconds,
	})

	test("a step that repeats needs the event that many times", () => {
		const dataset = caseDataset("repeats")
		expect(counts(dataset, byUser([ev("search"), ev("search")]))).toEqual([3, 2])
		expect(counts(dataset, byUser([ev("search"), ev("search"), ev("search")]))).toEqual([3, 2, 1])
	})

	test("rows in the same millisecond convert only in their recorded order", () => {
		expect(counts(caseDataset("sameMillisecond"), byUser([ev("cart"), ev("pay")]))).toEqual([2, 1])
	})

	test("the window includes its last millisecond and nothing after", () => {
		expect(counts(caseDataset("windowEdge"), byUser([ev("start"), ev("finish")]))).toEqual([4, 2])
	})

	test("a later attempt converts when the first one ran out of time", () => {
		const opts = byUser([ev("start"), ev("middle"), ev("finish")])
		expect(counts(caseDataset("restart"), opts)).toEqual([1, 1, 1])
		// The times are the converting attempt's: 5 minutes, then 15, not a span from the abandoned one.
		expect(sqlTiming(db, "case_restart", opts)).toEqual([
			{ step: 2, ...both(5 * MINUTE_MS), ...sinceStart(5 * MINUTE_MS) },
			{ step: 3, ...both(15 * MINUTE_MS), ...sinceStart(20 * MINUTE_MS) },
		])
	})

	test("where a leaver went is read after the attempt that got furthest", () => {
		const opts = byUser([ev("start"), ev("finish"), ev("never_happens")])
		expect(sqlLeavers(db, "case_restart", opts)).toEqual([[3, "settings_opened", 1]])
	})

	test("two events in one millisecond with nothing to order them convert, in either order", () => {
		const dataset = caseDataset("tiedServerEvents")
		const converted = byUser([ev("signup"), ev("plan")])
		expect(counts(dataset, converted)).toEqual([2, 2])
		expect(sqlTiming(db, dataset.orgId, converted)).toEqual([{ step: 2, ...both(0), ...sinceStart(0) }])
		// Counted as converted, so neither is a leaver of step 2; both went on to `later`.
		expect(sqlLeavers(db, dataset.orgId, byUser([ev("signup"), ev("plan"), ev("never")]))).toEqual([
			[3, "later", 2],
		])
	})

	test("the same event twice in one millisecond is two events, with no time between them", () => {
		const dataset = caseDataset("tiedServerEvents")
		const twice = byUser([ev("search"), ev("search")])
		expect(counts(dataset, twice)).toEqual([1, 1])
		expect(sqlTiming(db, dataset.orgId, twice)).toEqual([{ step: 2, ...both(0), ...sinceStart(0) }])
		expect(sqlLeavers(db, dataset.orgId, byUser([ev("search"), ev("search"), ev("never")]))).toEqual([
			[3, "later", 1],
		])
	})

	test("a long session keeps its order inside a millisecond past seq 1024", () => {
		expect(counts(caseDataset("longSession"), byUser([ev("cart"), ev("pay")]))).toEqual([1, 1])
	})

	test("one page view is not both a $pageview event step and a page step", () => {
		const byVisitor = (steps: ReadonlyArray<CH.FunnelStep>): Opts => ({
			steps,
			keyBy: "visitor",
			windowSeconds: 3_600,
		})
		expect(counts(VIEWS, byVisitor([ev("$pageview"), page("/pricing")]))).toEqual([2, 1])
		expect(counts(VIEWS, byVisitor([page("/pricing"), ev("$pageview")]))).toEqual([2, 1])
	})

	test("a session entry comes before the session's first event, and a visitor who sent nothing is a leaver", () => {
		const opts: Opts = {
			steps: [{ kind: "session", dimension: "utmSource", value: "twitter" }, page("/")],
			keyBy: "visitor",
			windowSeconds: 3_600,
		}
		expect(counts(ENTRIES, opts)).toEqual([2, 1])
		expect(sqlLeavers(db, ENTRIES.orgId, opts)).toEqual([[2, "", 1]])
	})

	test("steps done before the first one do not count", () => {
		expect(counts(caseDataset("outOfOrder"), byUser([ev("start"), ev("middle"), ev("finish")]))).toEqual([
			2, 1, 1,
		])
	})

	test("thousands of repeats of one event stay cheap to walk", () => {
		const opts = byUser([ev("search"), ev("search"), ev("search"), ev("checkout")])
		expect(counts(caseDataset("heavyRepeats"), opts)).toEqual([1, 1, 1, 1])
		// The earliest attempt that still fits the hour starts 3,600 s before the checkout:
		// three searches a second apart, then the wait for the checkout.
		expect(sqlTiming(db, "case_heavyRepeats", opts)).toEqual([
			{ step: 2, ...both(1_000), ...sinceStart(1_000) },
			{ step: 3, ...both(1_000), ...sinceStart(2_000) },
			{ step: 4, ...both(3_598_000), ...sinceStart(3_600_000) },
		])
	})

	test("quotes, backslashes and non-Latin names match literally", () => {
		const dataset = caseDataset("awkwardNames")
		const quoted = 'it\'s "quoted" \\ back'
		expect(counts(dataset, byUser([ev(quoted), ev("bestellt · 注文 🎉")]))).toEqual([2, 1])
		expect(counts(dataset, byUser([ev(quoted, { "plan's": "pro' OR '1'='1" })]))).toEqual([1])
	})

	test("a campaign visit stitches to the signup in a later session and the server-side plan", () => {
		const steps: ReadonlyArray<CH.FunnelStep> = [
			{ kind: "session", dimension: "utmSource", value: "twitter" },
			ev("signup_started"),
			ev("plan_started", { plan: "pro" }),
		]
		const week = 7 * 86_400
		expect(counts(ACQUISITION, { steps, keyBy: "person", windowSeconds: week })).toEqual([2, 2, 1])
		// Ann's signup is a day after her campaign visit: outside an hour, and in another session.
		expect(counts(ACQUISITION, { steps, keyBy: "person", windowSeconds: 3_600 })).toEqual([2, 1, 0])
		expect(counts(ACQUISITION, { steps, keyBy: "session", windowSeconds: week })).toEqual([2, 1, 0])
		expect(
			counts(ACQUISITION, { steps, keyBy: "person", windowSeconds: week, filters: { country: "DE" } }),
		).toEqual([1, 1, 1])
	})

	// The example products: every funnel below must match the reference exactly.

	const FUNNELS: ReadonlyArray<{
		readonly name: string
		readonly dataset: Dataset
		readonly opts: Omit<Opts, "keyBy">
	}> = [
		{
			name: "SaaS: landing to paid plan",
			dataset: saas,
			opts: {
				steps: [
					page("/", "acme.dev"),
					ev("signup_started"),
					ev("signup_completed"),
					ev("first_trace_received"),
					ev("plan_started"),
				],
				windowSeconds: 14 * 86_400,
			},
		},
		{
			name: "SaaS: signup to connected within a day",
			dataset: saas,
			opts: {
				steps: [
					ev("signup_started"),
					ev("signup_completed"),
					ev("onboarding_step_completed", { step: "connect" }),
				],
				windowSeconds: 86_400,
			},
		},
		{
			name: "SaaS: launch campaign to a startup plan",
			dataset: saas,
			opts: {
				steps: [
					{ kind: "session", dimension: "utmCampaign", value: "launch-week" },
					page("/pricing"),
					ev("signup_started"),
					ev("plan_started", { plan: "startup" }),
				],
				windowSeconds: 30 * 86_400,
			},
		},
		{
			name: "SaaS: German visitors only",
			dataset: saas,
			opts: {
				steps: [page("/"), page("/pricing"), ev("signup_started")],
				windowSeconds: 7 * 86_400,
				filters: { country: "DE" },
			},
		},
		{
			name: "SaaS: mobile Safari from the newsletter",
			dataset: saas,
			opts: {
				steps: [page("/"), ev("signup_started"), ev("signup_completed")],
				windowSeconds: 7 * 86_400,
				filters: { utmSource: "newsletter", deviceType: "mobile", browserName: "Safari" },
			},
		},
		{
			name: "Shop: view to order in one sitting",
			dataset: shop,
			opts: {
				steps: [
					ev("product_viewed"),
					ev("add_to_cart"),
					ev("checkout_started"),
					ev("payment_submitted"),
					ev("order_completed"),
				],
				windowSeconds: 3_600,
			},
		},
		{
			name: "Shop: browsed three products before buying",
			dataset: shop,
			opts: {
				steps: [
					ev("product_viewed"),
					ev("product_viewed"),
					ev("product_viewed"),
					ev("add_to_cart"),
					ev("order_completed"),
				],
				windowSeconds: 7 * 86_400,
			},
		},
		{
			name: "Shop: shoes paid by card",
			dataset: shop,
			opts: {
				steps: [
					ev("product_viewed", { category: "shoes" }),
					ev("add_to_cart", { category: "shoes" }),
					ev("payment_submitted", { method: "card" }),
					ev("order_completed", { method: "card" }),
				],
				windowSeconds: 86_400,
			},
		},
		{
			name: "Shop: checkout page then the checkout event in the same millisecond",
			dataset: shop,
			opts: {
				steps: [page("/checkout"), ev("checkout_started"), ev("payment_submitted")],
				windowSeconds: 3_600,
			},
		},
		{
			name: "Mobile: first open to a logged workout",
			dataset: mobile,
			opts: {
				steps: [
					ev("app_opened"),
					ev("permission_answered", { answer: "granted" }),
					ev("account_created"),
					ev("workout_logged"),
				],
				windowSeconds: 7 * 86_400,
			},
		},
		{
			name: "Mobile: welcome screen to the home screen",
			dataset: mobile,
			opts: {
				steps: [page("Welcome"), page("Permissions"), ev("account_created"), page("Home")],
				windowSeconds: 86_400,
			},
		},
		{
			name: "Mobile: came back for a second workout",
			dataset: mobile,
			opts: {
				steps: [ev("account_created"), ev("workout_logged"), ev("workout_logged")],
				windowSeconds: 14 * 86_400,
			},
		},
		{
			name: "Content: pricing on any host to signup",
			dataset: content,
			opts: { steps: [page("/pricing"), page("/signup"), ev("signup_started")], windowSeconds: 3_600 },
		},
		{
			name: "Content: pricing on the marketing host only",
			dataset: content,
			opts: {
				steps: [page("/pricing", "acme.dev"), page("/signup", "acme.dev"), ev("signup_started")],
				windowSeconds: 3_600,
			},
		},
		{
			name: "Content: from Hacker News",
			dataset: content,
			opts: {
				steps: [
					{ kind: "session", dimension: "referrerHost", value: "news.ycombinator.com" },
					page("/pricing"),
					page("/signup"),
				],
				windowSeconds: 86_400,
			},
		},
	]

	for (const funnel of FUNNELS) {
		for (const keyBy of KEYS) {
			test(`${funnel.name}, counted by ${keyBy}`, () => {
				const opts: Opts = { ...funnel.opts, keyBy }
				const expected = referenceFunnel(funnel.dataset, opts)
				expect(counts(funnel.dataset, opts)).toEqual([...expected])
				if (opts.steps.length < 2) return
				const timing = sqlTiming(db, funnel.dataset.orgId, opts)
				Arr.forEach(referenceTiming(funnel.dataset, opts), (step, index) => {
					expect(timing[index]?.step).toBe(step.step)
					expect(timing[index]?.p50Ms ?? Number.NaN).toBeCloseTo(step.p50Ms, 3)
					expect(timing[index]?.p90Ms ?? Number.NaN).toBeCloseTo(step.p90Ms, 3)
					expect(timing[index]?.sinceStartP50Ms ?? Number.NaN).toBeCloseTo(step.sinceStartP50Ms, 3)
					expect(timing[index]?.sinceStartP90Ms ?? Number.NaN).toBeCloseTo(step.sinceStartP90Ms, 3)
				})
				expect(sqlLeavers(db, funnel.dataset.orgId, opts)).toEqual([
					...referenceLeavers(funnel.dataset, opts),
				])
			})
		}
	}

	test("the example funnels are not empty: people enter each and fewer finish", () => {
		const entered = Arr.map(FUNNELS, (funnel) => {
			const result = counts(funnel.dataset, { ...funnel.opts, keyBy: "person" })
			return { name: funnel.name, first: result[0] ?? 0, last: result[result.length - 1] ?? 0 }
		})
		expect(Arr.filter(entered, (funnel) => funnel.first === 0)).toEqual([])
		expect(Arr.filter(entered, (funnel) => funnel.last >= funnel.first)).toEqual([])
	})

	const BREAKDOWNS: ReadonlyArray<{
		readonly name: string
		readonly dataset: Dataset
		readonly opts: CH.ProductEventsFunnelBreakdownOpts
	}> = [
		{
			name: "SaaS signups by UTM source",
			dataset: saas,
			opts: {
				steps: [page("/"), ev("signup_started"), ev("signup_completed")],
				keyBy: "person",
				windowSeconds: 14 * 86_400,
				breakdownBy: "utmSource",
			},
		},
		{
			name: "SaaS signups by country, top three",
			dataset: saas,
			opts: {
				steps: [page("/"), ev("signup_started")],
				keyBy: "visitor",
				windowSeconds: 7 * 86_400,
				breakdownBy: "country",
				limit: 3,
			},
		},
		{
			name: "SaaS plans by plan attribute",
			dataset: saas,
			opts: {
				steps: [ev("plan_started")],
				keyBy: "user",
				windowSeconds: 3_600,
				breakdownBy: "attribute:plan",
			},
		},
		{
			name: "Shop checkout by category",
			dataset: shop,
			opts: {
				steps: [ev("product_viewed"), ev("add_to_cart"), ev("checkout_started")],
				keyBy: "session",
				windowSeconds: 3_600,
				breakdownBy: "attribute:category",
			},
		},
		{
			name: "Shop checkout by referrer from a campaign entry",
			dataset: shop,
			opts: {
				steps: [
					{ kind: "session", dimension: "utmSource", value: "twitter" },
					ev("add_to_cart"),
					ev("order_completed"),
				],
				keyBy: "person",
				windowSeconds: 7 * 86_400,
				breakdownBy: "referrerHost",
			},
		},
		{
			name: "Content signups by host",
			dataset: content,
			opts: {
				steps: [page("/pricing"), page("/signup")],
				keyBy: "visitor",
				windowSeconds: 3_600,
				breakdownBy: "host",
			},
		},
		{
			name: "Mobile accounts by sign-in method",
			dataset: mobile,
			opts: {
				steps: [ev("account_created"), ev("workout_logged")],
				keyBy: "visitor",
				windowSeconds: 14 * 86_400,
				breakdownBy: "attribute:method",
			},
		},
	]

	for (const breakdown of BREAKDOWNS) {
		test(`breakdown: ${breakdown.name}`, () => {
			const expected = referenceBreakdown(breakdown.dataset, breakdown.opts)
			expect(expected.length).toBeGreaterThan(1)
			expect(sqlBreakdown(db, breakdown.dataset.orgId, breakdown.opts)).toEqual(
				Arr.map(expected, ([group, groupCounts]) => [group, [...groupCounts]] as const),
			)
		})
	}

	test(
		"random small histories agree with the reference under every key and window",
		() => {
			const mismatches = Arr.flatMap(random, ({ dataset, funnels }) =>
				Arr.flatMap(funnels, (opts) => {
					const expected = referenceFunnel(dataset, opts)
					const actual = sqlFunnel(db, dataset.orgId, opts)
					return Arr.every(expected, (count, index) => count === actual[index]) &&
						expected.length === actual.length
						? []
						: [{ org: dataset.orgId, opts, expected, actual, events: dataset.events }]
				}),
			)
			expect(mismatches.slice(0, 2)).toEqual([])
		},
		RANDOM_TEST_TIMEOUT_MS,
	)

	test(
		"random small histories give the reference's times and leavers",
		() => {
			const round = (timing: ReadonlyArray<StepTiming>) =>
				Arr.map(timing, (step) => [
					step.step,
					Math.round(step.p50Ms),
					Math.round(step.p90Ms),
					Math.round(step.sinceStartP50Ms),
					Math.round(step.sinceStartP90Ms),
				])
			const mismatches = Arr.flatMap(random, ({ dataset, funnels }) =>
				Arr.flatMap(
					Arr.filter(funnels, (opts: Opts) => opts.steps.length >= 2),
					(opts: Opts) => {
						const expected = {
							timing: round(referenceTiming(dataset, opts)),
							leavers: referenceLeavers(dataset, opts),
						}
						const actual = {
							timing: round(sqlTiming(db, dataset.orgId, opts)),
							leavers: sqlLeavers(db, dataset.orgId, opts),
						}
						return JSON.stringify(expected) === JSON.stringify(actual)
							? []
							: [{ org: dataset.orgId, opts, expected, actual, events: dataset.events }]
					},
				),
			)
			expect(mismatches.slice(0, 2)).toEqual([])
		},
		RANDOM_TEST_TIMEOUT_MS,
	)
})

/** Small random histories over a three-letter alphabet, each in its own org, with funnels to ask of it. */
function randomDatasets(
	count: number,
): ReadonlyArray<{ readonly dataset: Dataset; readonly funnels: ReadonlyArray<Opts> }> {
	const rng = seeded(97)
	const names = ["a", "b", "c"] as const
	return Arr.makeBy(count, (index) => {
		const orgId = `random_${index}`
		const people = 2 + rng.int(4)
		const events = Arr.flatMap(Arr.range(1, people), (person) => {
			const userId = rng.chance(0.7) ? `u${person}` : ""
			const visitorId = userId === "" || rng.chance(0.5) ? `v${person}` : ""
			const sessionId = visitorId === "" ? "" : `s${person}`
			let previousMs = -1
			return Arr.makeBy(1 + rng.int(9), (index) => {
				// One row in five lands in the millisecond of the one before it, and a server row
				// has no seq, so some rows tie outright.
				const atMs = previousMs >= 0 && rng.chance(0.2) ? previousMs : rng.int(4 * HOUR_MS)
				previousMs = atMs
				return event({
					atMs,
					seq: sessionId === "" ? 0 : index,
					userId,
					visitorId,
					sessionId,
					source: sessionId === "" ? "server" : "browser",
					eventName: rng.pick(names),
					attributes: rng.chance(0.3) ? { tier: rng.pick(["x", "y"] as const) } : {},
				})
			})
		})
		const funnels = Arr.makeBy(4, (): Opts => ({
			steps: Arr.makeBy(1 + rng.int(4), () =>
				rng.chance(0.2)
					? ev(rng.pick(names), { tier: rng.pick(["x", "y"] as const) })
					: ev(rng.pick(names)),
			),
			keyBy: rng.pick(["person", "visitor", "user", "session"] as const),
			windowSeconds: rng.pick([60, 600, 3_600, 86_400] as const),
		}))
		return { dataset: { orgId, events, sessions: [] }, funnels }
	})
}
