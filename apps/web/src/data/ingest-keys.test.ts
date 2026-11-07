import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Effect, Layer, Predicate, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { describe, expect, test } from "vitest"
import { MapleApiV2Client } from "../platform/api-clients"
import { retrieveIngestKeys } from "./ingest-keys"
import { SessionTenant } from "./session-tenant"

const keys = {
	object: "ingest_keys",
	public_key: "maple_pk_test",
	private_key: "maple_sk_test",
	public_rotated_at: "2026-11-01T00:00:00Z",
	private_rotated_at: "2026-11-01T00:00:00Z",
}

const run = (roles: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const sent = yield* Ref.make(0)
		const http = HttpClient.make((request) =>
			Ref.update(sent, (count) => count + 1).pipe(
				Effect.as(HttpClientResponse.fromWeb(request, Response.json(keys))),
			),
		)
		const tenant = Layer.succeed(SessionTenant, {
			get: Effect.succeed(
				Schema.decodeSync(CurrentTenant.TenantSchema)({
					orgId: "org_a",
					userId: "user_a",
					roles,
					authMode: "clerk",
				}),
			),
		})
		const client = Layer.effect(
			MapleApiV2Client,
			HttpApiClient.make(MapleApiV2, { baseUrl: "https://api.test" }),
		).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
		const result = yield* Effect.result(retrieveIngestKeys).pipe(Effect.provide([tenant, client]))
		return { result, requests: yield* Ref.get(sent) }
	}).pipe(Effect.runPromise)

describe("reading the ingest keys", () => {
	test("a member below engineer gets a permission failure without a request", async () => {
		const { result, requests } = await run(["org:member"])
		expect(requests).toBe(0)
		expect(result._tag).toBe("Failure")
		if (result._tag === "Failure")
			expect(Predicate.isTagged(result.failure, "@maple/http/v2/InsufficientPermissionsError")).toBe(
				true,
			)
	})

	test("an engineer reads them from the API", async () => {
		const { result, requests } = await run(["org:engineer"])
		expect(requests).toBe(1)
		expect(result._tag).toBe("Success")
	})
})
