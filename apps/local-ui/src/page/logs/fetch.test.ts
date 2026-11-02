import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import { fetchLogsPage, fetchPatterns, fetchServices, fetchSeverities } from "./fetch"
import type { LogFilters } from "./filters"

const BOUNDS = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }
const API = "http://127.0.0.1:4318"
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ sql: Schema.String })))

/** The SQL a fetch POSTs to `/local/query`, answered with no rows. */
const sqlOf = (fetch: Effect.Effect<unknown, unknown, HttpClient.HttpClient>): Promise<string> => {
	const sent: Array<string> = []
	return Effect.runPromise(
		fetch.pipe(
			Effect.provideService(
				HttpClient.HttpClient,
				HttpClient.make((request) => {
					if (request.body._tag === "Uint8Array") sent.push(decodeBody(new TextDecoder().decode(request.body.body)).sql)
					return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 })))
				}),
			),
			Effect.andThen(Effect.sync(() => sent.join("\n"))),
		),
	)
}

// A value that would end the string literal and add its own predicate if it were not escaped.
const HOSTILE = "/a') OR 1=1 --"
const filters: LogFilters = { attrs: [`log:http.route=${HOSTILE}`, `!res:k8s.namespace.name=shop`] }

describe("local logs queries", () => {
	test.each([
		["list", fetchLogsPage(filters, BOUNDS, undefined, API)],
		["patterns", fetchPatterns(filters, BOUNDS, API)],
		["services", fetchServices(filters, BOUNDS, API)],
		["severities", fetchSeverities(filters, BOUNDS, API)],
	])("the %s query carries the attribute filters, the value escaped", async (_, fetch) => {
		const sql = await sqlOf(fetch)
		expect(sql).toContain("'k8s.namespace.name'")
		expect(sql).toContain("'shop'")
		expect(sql).toContain("'/a\\') OR 1=1 --'")
		expect(sql).not.toContain("'/a')")
	})
})
