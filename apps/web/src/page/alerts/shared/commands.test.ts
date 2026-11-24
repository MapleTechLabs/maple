import { describe, it } from "@effect/vitest"
import { encodePublicId, MapleApiV2 } from "@maple/domain/http/v2"
import { AlertIncidentId } from "@maple/primitives"
import { Effect, Layer, Option, Ref, Schema, Array as Arr, String as Str } from "effect"
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { expect } from "vitest"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { listDeliveriesRaw } from "./commands"

const INCIDENT = "00000000-0000-4000-8000-0000000000a1"
const uuid = (n: number) => `00000000-0000-4000-8000-${Str.padStart(12, "0")(String(n))}`

const delivery = (n: number) => ({
	id: encodePublicId("evt", uuid(n)),
	object: "alert_delivery",
	incident_id: encodePublicId("inc", INCIDENT),
	rule_id: encodePublicId("alrt", uuid(900)),
	destination_id: encodePublicId("dest", uuid(901)),
	destination_name: "On-call",
	destination_type: "webhook",
	delivery_key: `key-${n}`,
	event_type: n === 1 ? "trigger" : "renotify",
	attempt_number: 1,
	status: "success",
	scheduled_at: "2026-11-10T08:00:00.000Z",
	attempted_at: "2026-11-10T08:00:00.000Z",
	provider_message: null,
	provider_reference: null,
	response_code: 200,
	error_message: null,
})

/** A client whose delivery list answers `pages` in order, recording each request's cursor. */
const clientOver = (
	pages: ReadonlyArray<Record<string, unknown>>,
	cursors: Ref.Ref<ReadonlyArray<string | null>>,
) => {
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
	return Layer.effect(
		MapleApiV2Client,
		HttpApiClient.make(MapleApiV2, { baseUrl: "https://api.test" }),
	).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
}

describe("listDeliveriesRaw", () => {
	const pages = [
		{ data: [delivery(3), delivery(2)], has_more: true, next_cursor: "older" },
		{ data: [delivery(1)], has_more: false, next_cursor: null },
	]

	it.effect("reads every delivery of one incident, down to the page that opened it", () =>
		Effect.gen(function* () {
			const cursors = yield* Ref.make<ReadonlyArray<string | null>>([])
			const deliveries = yield* listDeliveriesRaw(Schema.decodeSync(AlertIncidentId)(INCIDENT)).pipe(
				Effect.provide(clientOver(pages, cursors)),
			)
			expect(Arr.map(deliveries, (row) => row.eventType)).toEqual(["renotify", "renotify", "trigger"])
			expect(yield* Ref.get(cursors)).toEqual([null, "older"])
		}),
	)

	it.effect("reads only the newest page of the org's deliveries", () =>
		Effect.gen(function* () {
			const cursors = yield* Ref.make<ReadonlyArray<string | null>>([])
			const deliveries = yield* listDeliveriesRaw().pipe(Effect.provide(clientOver(pages, cursors)))
			expect(deliveries).toHaveLength(2)
			expect(yield* Ref.get(cursors)).toEqual([null])
		}),
	)
})
