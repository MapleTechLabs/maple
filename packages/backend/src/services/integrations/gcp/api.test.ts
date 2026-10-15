import { assert, describe, it } from "@effect/vitest"
import { GCP_METRIC_GROUPS } from "@maple/domain/gcp-metrics"
import { GcpProjectId } from "@maple/domain/primitives"
import { Effect, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { listTimeSeriesPage, MAX_BODY_BYTES } from "./api"

const reader = {
	accessToken: Redacted.make("ya29.reader"),
	quotaProject: Schema.decodeSync(GcpProjectId)("acme-prod"),
}
const group = GCP_METRIC_GROUPS[0]!

describe("Google calls the poller makes", () => {
	it.effect("read a page past the live queries' size cap in full", () => {
		const label = "x".repeat(MAX_BODY_BYTES + 1)
		const stub = (async () =>
			new Response(
				JSON.stringify({ timeSeries: [{ metric: { labels: { label } }, resource: { labels: {} } }] }),
				{ headers: { "content-type": "application/json" } },
			)) as typeof fetch
		return Effect.gen(function* () {
			const httpClient = yield* HttpClient.HttpClient
			const page = yield* listTimeSeriesPage(
				httpClient,
				reader,
				{ scope: "projects/acme-prod", group, metric: group.metrics[0]!, startMs: 0, endMs: 60_000 },
				undefined,
			)
			assert.strictEqual(page.timeSeries?.[0]?.metric.labels?.label, label)
		}).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, stub))
	})
})
