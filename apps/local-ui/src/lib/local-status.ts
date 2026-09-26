// Probe for the local server's `GET /local/status`. Every outcome is data, not
// a thrown error: "busy" (chDB is mid-query, the single JS thread can't answer)
// and "refused" (nothing is listening) need different screens.

import { Effect, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"

export const LocalServerStatus = Schema.Struct({
	service: Schema.String,
	pid: Schema.Number,
	version: Schema.String,
	url: Schema.String,
	dataDir: Schema.String,
	lastIngestAtMs: Schema.NullOr(Schema.Number),
})
export type LocalServerStatus = Schema.Schema.Type<typeof LocalServerStatus>

export type StatusProbe =
	| { readonly _tag: "Ok"; readonly status: LocalServerStatus }
	/** 404: a binary from before `/local/status` existed. */
	| { readonly _tag: "Legacy" }
	/** Accepted the connection but did not answer in time. */
	| { readonly _tag: "Busy" }
	/** Nothing answered: the binary is not running (or the browser blocked loopback). */
	| { readonly _tag: "Refused" }
	/** Answered with a refusal (403 origin rejected, 400, 5xx) or an unreadable body. */
	| { readonly _tag: "Rejected"; readonly status: number; readonly detail: string }

const decodeStatus = HttpClientResponse.schemaBodyJson(LocalServerStatus)

const classify = (response: HttpClientResponse.HttpClientResponse) =>
	Effect.gen(function* () {
		if (response.status === 404) return { _tag: "Legacy" } satisfies StatusProbe
		if (response.status < 200 || response.status >= 300) {
			const detail = (yield* response.text.pipe(Effect.orElseSucceed(() => ""))).trim()
			return { _tag: "Rejected", status: response.status, detail } satisfies StatusProbe
		}
		return yield* decodeStatus(response).pipe(
			Effect.map((status): StatusProbe => ({ _tag: "Ok", status })),
			Effect.orElseSucceed(
				(): StatusProbe => ({
					_tag: "Rejected",
					status: response.status,
					detail: "The status response was not the expected JSON.",
				}),
			),
		)
	})

/** Probe `${baseUrl}/local/status`, giving up (as `Busy`) after `timeoutMs`. */
export const probeLocalStatus = (baseUrl: string, timeoutMs: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const http = yield* HttpClient.HttpClient
			return yield* HttpClient.withScope(http)
				.get(`${baseUrl}/local/status`)
				.pipe(
					Effect.flatMap(classify),
					Effect.orElseSucceed((): StatusProbe => ({ _tag: "Refused" })),
				)
		}),
	).pipe(
		Effect.timeoutOption(timeoutMs),
		Effect.map(Option.getOrElse((): StatusProbe => ({ _tag: "Busy" }))),
	)

export const runStatusProbe = (
	baseUrl: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<StatusProbe> =>
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.runPromise(probeLocalStatus(baseUrl, timeoutMs).pipe(Effect.provide(FetchHttpClient.layer)), {
		signal,
	})
