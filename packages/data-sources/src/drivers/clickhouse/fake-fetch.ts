import { Array as Arr, Effect, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { ExternalDataSourceId } from "@maple/domain/data-sources"
import type { DriverConnection } from "../../port"
import type { ClickHouseDataSourceConfig } from "@maple/domain/data-sources"

// Test helpers: a fetch that answers by SQL text and records what the driver sent.

export interface SentRequest {
	readonly url: URL
	readonly sql: string
}

export type Answer = (sql: string, url: URL) => Response | Promise<Response>

export const fakeFetch = (answer: Answer) => {
	const sent: Array<SentRequest> = []
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input)
		const sql = await new Response(init?.body).text()
		sent.push({ url, sql })
		return answer(sql, url)
	}
	// Each test is its own entry point, so each provides the HTTP client.
	const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			// @effect-diagnostics-next-line strictEffectProvide:off
			Effect.provide(FetchHttpClient.layer),
			Effect.provideService(FetchHttpClient.Fetch, fetch),
		)
	return { sent, provide }
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export const rows = (...lines: ReadonlyArray<Record<string, unknown>>) =>
	new Response(Arr.join(Arr.map(lines, (line) => encodeJson(line)), "\n"), { status: 200 })

export const chError = (status: number, code: number, text: string) =>
	new Response(`Code: ${code}. DB::Exception: ${text} (version 26.2.19.43 (official build))`, {
		status,
		headers: { "x-clickhouse-exception-code": String(code) },
	})

export const connection: DriverConnection<ClickHouseDataSourceConfig> = {
	sourceId: Schema.decodeSync(ExternalDataSourceId)("0193a7a4-1c0b-7cc4-9d55-6a1f3c2b9e10"),
	config: { _tag: "clickhouse", url: "https://ch.example.com:8443/", user: "reader", database: "shop" },
	secret: Redacted.make("s3cret-pw"),
}
