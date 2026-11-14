import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Effect, Layer, Predicate, Ref, Schema, String as Str } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { describe, expect, test } from "vitest"
import { MapleApiV2Client } from "../platform/api-clients"
import { retrieveIngestKeys, retrieveSetupKeys } from "./ingest-keys"
import { SessionTenant } from "./session-tenant"

const keys = {
	object: "ingest_keys",
	public_key: "maple_pk_test",
	private_key: "maple_sk_test",
	public_rotated_at: "2026-11-01T00:00:00Z",
	private_rotated_at: "2026-11-01T00:00:00Z",
}

const publicKey = {
	object: "public_ingest_key",
	public_key: "maple_pk_test",
	public_rotated_at: "2026-11-01T00:00:00Z",
}

const denied = {
	error: {
		_tag: "@maple/http/v2/InsufficientPermissionsError",
		type: "permission_error",
		code: "insufficient_permissions",
		title: "Permission required",
		message: "Only org admins and engineers can view ingest keys.",
		retryable: false,
		recovery: "request_access",
	},
}

/** What `GET /v2/ingest_keys` answers; the public read always succeeds. */
type BothKeysAnswer = "keys" | "denied" | "outage"

const answer = (request: HttpClientRequest.HttpClientRequest, both: BothKeysAnswer): Response =>
	Str.endsWith("/public")(request.url)
		? Response.json(publicKey)
		: both === "keys"
			? Response.json(keys)
			: both === "denied"
				? Response.json(denied, { status: 403 })
				: new Response("upstream down", { status: 503 })

const run = <A, E>(
	roles: ReadonlyArray<string>,
	read: Effect.Effect<A, E, SessionTenant | MapleApiV2Client>,
	both: BothKeysAnswer = "keys",
) =>
	Effect.gen(function* () {
		const sent = yield* Ref.make(0)
		const http = HttpClient.make((request) =>
			Ref.update(sent, (count) => count + 1).pipe(
				Effect.as(HttpClientResponse.fromWeb(request, answer(request, both))),
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
		const result = yield* Effect.result(read).pipe(Effect.provide([tenant, client]))
		return { result, requests: yield* Ref.get(sent) }
	}).pipe(Effect.runPromise)

describe("reading the ingest keys", () => {
	test("a member below engineer gets a permission failure without a request", async () => {
		const { result, requests } = await run(["org:member"], retrieveIngestKeys)
		expect(requests).toBe(0)
		expect(result._tag).toBe("Failure")
		if (result._tag === "Failure")
			expect(Predicate.isTagged(result.failure, "@maple/http/v2/InsufficientPermissionsError")).toBe(
				true,
			)
	})

	test("an engineer reads them from the API", async () => {
		const { result, requests } = await run(["org:engineer"], retrieveIngestKeys)
		expect(requests).toBe(1)
		expect(result._tag).toBe("Success")
	})

	test("setup screens give a member the public key and an engineer both", async () => {
		const member = await run(["org:member"], retrieveSetupKeys)
		expect(member.requests).toBe(1)
		expect(member.result).toEqual(
			expect.objectContaining({ success: { privateKey: null, publicKey: "maple_pk_test" } }),
		)
		const engineer = await run(["org:engineer"], retrieveSetupKeys)
		expect(engineer.result).toEqual(
			expect.objectContaining({ success: { privateKey: "maple_sk_test", publicKey: "maple_pk_test" } }),
		)
	})

	test("a refusal from the API itself also falls back to the public key", async () => {
		const { result, requests } = await run(["org:engineer"], retrieveSetupKeys, "denied")
		expect(requests).toBe(2)
		expect(result).toEqual(
			expect.objectContaining({ success: { privateKey: null, publicKey: "maple_pk_test" } }),
		)
	})

	test("a key store outage stays a failure, so an admin is never handed the public key instead", async () => {
		const { result, requests } = await run(["org:admin"], retrieveSetupKeys, "outage")
		expect(requests).toBe(1)
		expect(result._tag).toBe("Failure")
	})
})
