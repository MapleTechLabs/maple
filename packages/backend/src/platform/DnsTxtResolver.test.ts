import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { DnsTxtResolver } from "./DnsTxtResolver"

const resolverAnswering = (status: number, body: unknown, urls: Array<string> = []) =>
	Layer.effect(DnsTxtResolver, DnsTxtResolver.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(
			Layer.succeed(FetchHttpClient.Fetch, (async (input: string | URL | Request) => {
				urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
				return new Response(JSON.stringify(body), { status })
			}) as typeof fetch),
		),
	)

describe("DnsTxtResolver", () => {
	it.effect("joins split TXT strings and drops other record types", () => {
		const urls: Array<string> = []
		return Effect.gen(function* () {
			const dns = yield* DnsTxtResolver
			const values = yield* dns.lookupTxt("_maple-challenge.acme.com")
			assert.deepStrictEqual(values, ["maple-domain-verification=abc123", 'say "hi"'])
			assert.include(urls[0], "name=_maple-challenge.acme.com")
			assert.include(urls[0], "type=TXT")
		}).pipe(
			Effect.provide(
				resolverAnswering(
					200,
					{
						Status: 0,
						Answer: [
							{ type: 5, data: "alias.acme.com." },
							{ type: 16, data: '"maple-domain-verification=" "abc123"' },
							{ type: 16, data: '"say \\"hi\\""' },
						],
					},
					urls,
				),
			),
		)
	})

	it.effect("reads a missing name as no records, and a resolver failure as an error", () =>
		Effect.gen(function* () {
			const missing = yield* DnsTxtResolver.pipe(
				Effect.flatMap((dns) => dns.lookupTxt("_maple-challenge.nope.example")),
				Effect.provide(resolverAnswering(200, { Status: 3 })),
			)
			assert.deepStrictEqual(missing, [])

			const servfail = yield* DnsTxtResolver.pipe(
				Effect.flatMap((dns) => dns.lookupTxt("_maple-challenge.acme.com")),
				Effect.flip,
				Effect.provide(resolverAnswering(200, { Status: 2 })),
			)
			assert.strictEqual(servfail._tag, "@maple/backend/platform/DnsLookupError")
		}),
	)
})
