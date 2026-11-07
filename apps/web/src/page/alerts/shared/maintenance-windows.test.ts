import { describe, it } from "@effect/vitest"
import { MapleApiV2, V2AlertMaintenanceWindow, V2AlertSilence } from "@maple/domain/http/v2"
import { Effect, Layer, Option, Ref, Schema, Array as Arr } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, UrlParams } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { expect } from "vitest"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { listMaintenanceWindows, listWindowSilences, windowPublicId } from "./maintenance-windows"
import { endedWindow, silencesWithWindows, weeklyWindow } from "./maintenance-test-fixtures"

type Seen = Readonly<{ cursor: string | null; window: string | null }>

/** A client whose pages come from `pages` in order, recording each request's cursor and filter. */
const pagedClient = (seen: Ref.Ref<ReadonlyArray<Seen>>, pages: ReadonlyArray<Record<string, unknown>>) => {
	const http = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
		Ref.modify(seen, (previous) => [
			previous.length,
			[
				...previous,
				{
					cursor: Option.getOrNull(UrlParams.getFirst(request.urlParams, "cursor")),
					window: Option.getOrNull(UrlParams.getFirst(request.urlParams, "maintenance_window_id")),
				},
			],
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

const encodeWindow = Schema.encodeSync(V2AlertMaintenanceWindow)
const encodeSilence = Schema.encodeSync(V2AlertSilence)

describe("listMaintenanceWindows", () => {
	it.effect("follows next_cursor until has_more is false", () =>
		Effect.gen(function* () {
			const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
			const client = pagedClient(seen, [
				{ data: [encodeWindow(weeklyWindow)], has_more: true, next_cursor: "page-2" },
				{ data: [encodeWindow(endedWindow)], has_more: false, next_cursor: null },
			])
			const windows = yield* listMaintenanceWindows.pipe(Effect.provide(client))
			expect(Arr.map(windows, (window) => window.id)).toEqual([weeklyWindow.id, endedWindow.id])
			expect(Arr.map(yield* Ref.get(seen), (request) => request.cursor)).toEqual([null, "page-2"])
		}),
	)
})

describe("listWindowSilences", () => {
	it.effect("asks the API for one window's silences, every page of them", () =>
		Effect.gen(function* () {
			const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
			const [first, second] = silencesWithWindows
			const client = pagedClient(seen, [
				{
					data: first === undefined ? [] : [encodeSilence(first)],
					has_more: true,
					next_cursor: "p2",
				},
				{
					data: second === undefined ? [] : [encodeSilence(second)],
					has_more: false,
					next_cursor: null,
				},
			])
			const silences = yield* listWindowSilences(weeklyWindow.id).pipe(Effect.provide(client))
			expect(silences).toHaveLength(2)
			const requests = yield* Ref.get(seen)
			expect(Arr.map(requests, (request) => request.cursor)).toEqual([null, "p2"])
			expect(Arr.map(requests, (request) => request.window)).toEqual([
				windowPublicId(weeklyWindow.id),
				windowPublicId(weeklyWindow.id),
			])
		}),
	)
})
