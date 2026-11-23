import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { HttpMiddleware, HttpServerRequest, UrlParams } from "effect/http"
import { ApiObservabilityLive } from "./api-observability"

const tracedFor = (url: string, method = "GET") =>
	Effect.gen(function* () {
		const disabled = yield* HttpMiddleware.TracerDisabledWhen
		return !disabled(HttpServerRequest.fromWeb(new Request(`https://api.maple.dev${url}`, { method })))
	}).pipe(Effect.provide(ApiObservabilityLive), Effect.runSync)

describe("ApiObservabilityLive", () => {
	// The ping routes redact the token themselves; a path no route matches would record it.
	it("traces heartbeat pings but no other method or path under /hb/", () => {
		expect(tracedFor("/hb/abc123secret")).toBe(true)
		expect(tracedFor("/hb/abc123secret/fail", "POST")).toBe(true)
		expect(tracedFor("/hb/abc123secret?source=cron")).toBe(true)
		expect(tracedFor("/hb/abc123secret/typo")).toBe(false)
		expect(tracedFor("/hb/abc123secret/fail/again")).toBe(false)
		expect(tracedFor("/hb/abc123secret", "HEAD")).toBe(false)
		expect(tracedFor("/hb/abc123secret%zz")).toBe(false)
		expect(tracedFor("/hb/abc%41123secret/fail", "POST")).toBe(false)
		expect(tracedFor("/hb/abc123secret/fail", "PUT")).toBe(false)
	})

	// The audit log is filtered by a member's email. The span of that request is kept for weeks
	// and read by people who cannot open the audit log.
	it("keeps an audit actor filter out of the URL a server span records", () => {
		const recorded = Effect.gen(function* () {
			const names = yield* UrlParams.CurrentRedactedNames
			return UrlParams.redactUrl(
				"https://api.maple.dev/internal/audit-trail/events?actor=ada%40acme.test&category=membership&sig=abc",
				names,
			)
		}).pipe(Effect.provide(ApiObservabilityLive), Effect.runSync)

		expect(recorded).not.toContain("ada")
		expect(recorded).toContain("category=membership")
		// Effect's own defaults still apply.
		expect(recorded).not.toContain("abc")
	})

	it("keeps PromQL text out of the URL a server span records", () => {
		const recorded = Effect.gen(function* () {
			const names = yield* UrlParams.CurrentRedactedNames
			return UrlParams.redactUrl(
				"https://api.maple.dev/api/v2/prometheus/api/v1/series?match%5B%5D=up%7Buser%3D%22ada%22%7D&query=rate(x%7Bcustomer%3D%22acme%22%7D%5B5m%5D)&step=60",
				names,
			)
		}).pipe(Effect.provide(ApiObservabilityLive), Effect.runSync)

		expect(recorded).not.toContain("ada")
		expect(recorded).not.toContain("acme")
		expect(recorded).toContain("step=60")
	})

	it("still traces ordinary API routes", () => {
		expect(tracedFor("/api/v2/uptime_monitors")).toBe(true)
		expect(tracedFor("/hbx")).toBe(true)
	})
})
