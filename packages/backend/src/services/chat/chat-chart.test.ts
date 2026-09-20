import { describe, expect, it } from "vitest"
import { Result, Schema } from "effect"
import { ShareChartResponse } from "@maple/domain/http"
import { OrgId } from "@maple/domain/primitives"
import { ChatMessage } from "@maple/domain/chat-session"
import { chatChartId, verifyChatChartId, type VerifiedChatChartClaims } from "@maple/db"
import { chatChartFrom, chatChartImageUrl, chatChartResponse, chatChartSession } from "./chat-chart"
import { parseChartSpec } from "@maple/domain/chat-chart-spec"

const KEY = "test-share-hmac-key"
const ORG_ID = Schema.decodeSync(OrgId)("org_2fJ8xQ1aBcDeFgHiJkLmNoPqRs")
const SESSION_ID = `${ORG_ID}:tab-8f21`
const MESSAGE_ID = "01JB8QK0Q9R5W0C4V8ZD2M6X7T"

const claimsFor = (id: string): VerifiedChatChartClaims => {
	const claims = verifyChatChartId(id, KEY)
	if (claims === undefined) throw new Error("expected the id this test just minted to verify")
	return claims
}

const claims = (chartIndex: number, overrides?: { readonly sessionId?: string }) =>
	claimsFor(
		chatChartId(
			{
				orgId: ORG_ID,
				sessionId: overrides?.sessionId ?? SESSION_ID,
				messageId: MESSAGE_ID,
				chartIndex,
			},
			KEY,
		),
	)

const fence = (body: string) => ["```chart", body, "```"].join("\n")

const reply = (text: string, overrides?: { readonly role?: "user" | "assistant"; readonly id?: string }) =>
	new ChatMessage({
		id: overrides?.id ?? MESSAGE_ID,
		role: overrides?.role ?? "assistant",
		text,
		toolCalls: [],
		createdAt: 1_770_000_000_000,
		startSeq: 1,
	})

const LINE_SOURCE = JSON.stringify({
	type: "line",
	title: "p95 latency",
	unit: "ms",
	data: [
		{ bucket: "2026-09-11T10:00:00Z", series: { "checkout-api": 142, "cart-api": 61 } },
		{ bucket: "2026-09-11T10:01:00Z", series: { "checkout-api": 388, "cart-api": 58 } },
	],
})
const LINE = fence(LINE_SOURCE)

const RANKED_SOURCE = JSON.stringify({
	type: "ranked",
	title: "errors by type",
	unit: "count",
	data: [
		{ name: "TimeoutError", value: 412 },
		{ name: "AuthError", value: 88 },
	],
})
const RANKED = fence(RANKED_SOURCE)

describe("chatChartImageUrl", () => {
	it("points at the signed image path on the app's own origin", () => {
		const url = chatChartImageUrl({
			appBaseUrl: "https://app.maple.dev",
			hmacKey: KEY,
			orgId: ORG_ID,
			sessionId: SESSION_ID,
			messageId: MESSAGE_ID,
			chartIndex: 0,
		})

		expect(url).toMatch(/^https:\/\/app\.maple\.dev\/chat\/chart\/.+\.png$/)
		// The conversation is not readable off the URL: it is inside the signed
		// payload, base64url-encoded, not a path segment.
		expect(url).not.toContain("tab-8f21")
	})

	it("mints nothing when the deployment has no signing key", () => {
		expect(
			chatChartImageUrl({
				appBaseUrl: "https://app.maple.dev",
				hmacKey: null,
				orgId: ORG_ID,
				sessionId: SESSION_ID,
				messageId: MESSAGE_ID,
				chartIndex: 0,
			}),
		).toBeNull()
	})
})

describe("chatChartSession", () => {
	it("hands back the conversation to read when the id's two orgs agree", () => {
		expect(chatChartSession(claims(0))).toBe(SESSION_ID)
	})

	it("refuses an id whose session belongs to another org", () => {
		// The signature proves this repo minted the payload; it does not make its
		// two halves agree. A URL claiming one org while naming another org's
		// conversation must not reach that conversation at all.
		expect(chatChartSession(claims(0, { sessionId: "org_other:tab-8f21" }))).toBeNull()
	})

	it("refuses a session id that names no org", () => {
		expect(chatChartSession(claims(0, { sessionId: "tab-8f21" }))).toBeNull()
		expect(chatChartSession(claims(0, { sessionId: ":tab-8f21" }))).toBeNull()
	})
})

describe("chatChartFrom", () => {
	it("reads the chart at the index the id names", () => {
		const messages = [reply(`Latency climbed.\n\n${LINE}\n\nAnd by type:\n\n${RANKED}`)]

		const first = chatChartFrom(messages, claims(0))
		expect(first?.kind).toBe("line")

		const second = chatChartFrom(messages, claims(1))
		expect(second?.kind).toBe("ranked")
	})

	it("finds nothing past the last chart in the reply", () => {
		expect(chatChartFrom([reply(LINE)], claims(1))).toBeNull()
	})

	it("refuses a user message, so only the agent's own charts are readable", () => {
		expect(chatChartFrom([reply(LINE, { role: "user" })], claims(0))).toBeNull()
	})

	it("finds nothing when the reply is no longer in the transcript", () => {
		expect(chatChartFrom([reply(LINE, { id: "another-message" })], claims(0))).toBeNull()
	})

	it("finds nothing when the fence is not a chart after all", () => {
		expect(chatChartFrom([reply(fence("{ not json"))], claims(0))).toBeNull()
	})
})

describe("chatChartResponse", () => {
	const specOf = (source: string) => {
		const spec = parseChartSpec(source)
		if (spec === null) throw new Error("expected a chart spec")
		return spec
	}

	it("turns a fence's rows inside out into one entry per series", () => {
		const chart = chatChartResponse(
			specOf(
				JSON.stringify({
					type: "line",
					title: "p95 latency",
					unit: "ms",
					data: [
						{ bucket: "2026-09-11T10:00:00Z", series: { "checkout-api": 142, "cart-api": 61 } },
						{ bucket: "2026-09-11T10:01:00Z", series: { "checkout-api": 388 } },
					],
				}),
			),
		)
		if (chart.kind === "ranked") throw new Error("expected a timeseries chart")

		expect(chart.unit).toBe("duration_ms")
		expect(chart.series.map((series) => series.name)).toEqual(["checkout-api", "cart-api"])
		expect(chart.series[0]?.points).toEqual([
			[Date.parse("2026-09-11T10:00:00Z"), 142],
			[Date.parse("2026-09-11T10:01:00Z"), 388],
		])
		// A series the later rows stop naming keeps the points it does have.
		expect(chart.series[1]?.points).toHaveLength(1)
	})

	it("scales values into the unit the image renderer draws in", () => {
		const chart = chatChartResponse(
			specOf(
				JSON.stringify({
					type: "line",
					unit: "s",
					data: [{ bucket: "2026-09-11T10:00:00Z", series: { api: 1.5 } }],
				}),
			),
		)
		if (chart.kind === "ranked") throw new Error("expected a timeseries chart")

		expect(chart.unit).toBe("duration_ms")
		expect(chart.series[0]?.points[0]?.[1]).toBe(1500)
	})

	it("bounds a fence a model wrote without one", () => {
		const chart = chatChartResponse(
			specOf(
				JSON.stringify({
					type: "line",
					data: Array.from({ length: 400 }, (_, i) => ({
						bucket: new Date(Date.UTC(2026, 8, 11, 0, i)).toISOString(),
						series: { api: i },
					})),
				}),
			),
		)
		if (chart.kind === "ranked") throw new Error("expected a timeseries chart")

		expect(chart.series[0]?.points.length).toBeLessThanOrEqual(60)
	})

	it("drops a value that scaling took off the number line", () => {
		// `ChartSpec` checks finiteness before scaling; ×1000 for seconds can undo
		// it. A non-finite number encodes as a JSON `null` and plots as a NaN
		// coordinate, so it must not reach the wire.
		const chart = chatChartResponse(
			specOf(
				JSON.stringify({
					type: "line",
					unit: "s",
					data: [
						{ bucket: "2026-09-11T10:00:00Z", series: { api: 1.5 } },
						{ bucket: "2026-09-11T10:01:00Z", series: { api: Number.MAX_VALUE } },
					],
				}),
			),
		)
		if (chart.kind === "ranked") throw new Error("expected a timeseries chart")

		expect(chart.series[0]?.points).toEqual([[Date.parse("2026-09-11T10:00:00Z"), 1500]])
	})

	it("bounds the series a fence can name, keeping the biggest", () => {
		const chart = chatChartResponse(
			specOf(
				JSON.stringify({
					type: "line",
					data: [
						{
							bucket: "2026-09-11T10:00:00Z",
							series: Object.fromEntries(
								Array.from({ length: 200 }, (_, i) => [`svc-${i}`, i]),
							),
						},
					],
				}),
			),
		)
		if (chart.kind === "ranked") throw new Error("expected a timeseries chart")

		expect(chart.series.length).toBeLessThanOrEqual(12)
		expect(chart.series[0]?.name).toBe("svc-199")
	})

	it("encodes as the wire contract, not just as something the compiler accepts", () => {
		// `Schema.Class`'s type side is structural, so an object literal would
		// type-check here and fail at response encoding. This runs the real encode.
		for (const source of [RANKED_SOURCE, LINE_SOURCE]) {
			const encoded = Schema.encodeUnknownResult(ShareChartResponse)(chatChartResponse(specOf(source)))
			expect(Result.isSuccess(encoded)).toBe(true)
		}
	})

	it("keeps a ranking in the order the model ranked it", () => {
		const chart = chatChartResponse(specOf(RANKED_SOURCE))
		if (chart.kind !== "ranked") throw new Error("expected a ranked chart")

		expect(chart.unit).toBe("number")
		expect(chart.points).toEqual([
			{ name: "TimeoutError", value: 412 },
			{ name: "AuthError", value: 88 },
		])
	})
})
