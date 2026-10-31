import { describe, it } from "@effect/vitest"
import { MapleApiV2, V2UptimeMonitor } from "@maple/domain/http/v2"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { expect } from "vitest"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { listMonitors } from "./uptime-commands"
import { httpMonitor, monitorId } from "./uptime-test-monitors"

const encode = Schema.encodeSync(V2UptimeMonitor)

describe("listMonitors", () => {
	it.effect("follows next_cursor until the last page", () =>
		Effect.gen(function* () {
			const cursors = yield* Ref.make<ReadonlyArray<string | null>>([])
			const pages = [
				{ data: [encode(httpMonitor({ id: monitorId(1) }))], has_more: true, next_cursor: "page-2" },
				{ data: [encode(httpMonitor({ id: monitorId(2) }))], has_more: false, next_cursor: null },
			]
			const http = HttpClient.make((request) =>
				Ref.modify(cursors, (seen) => [
					seen.length,
					[...seen, Option.getOrNull(UrlParams.getFirst(request.urlParams, "cursor"))],
				]).pipe(
					Effect.map((index) =>
						HttpClientResponse.fromWeb(
							request,
							Response.json({ object: "list", ...pages[Math.min(index, pages.length - 1)] }),
						),
					),
				),
			)
			const client = Layer.effect(
				MapleApiV2Client,
				HttpApiClient.make(MapleApiV2, { baseUrl: "https://api.test" }),
			).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
			const monitors = yield* listMonitors.pipe(Effect.provide(client))
			expect(monitors.map((monitor) => monitor.id)).toEqual([monitorId(1), monitorId(2)])
			expect(yield* Ref.get(cursors)).toEqual([null, "page-2"])
		}),
	)
})
