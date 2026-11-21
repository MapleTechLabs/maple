import * as Clerk from "@distilled.cloud/clerk"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Redacted, Tracer, Array as Arr } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { CLERK_REQUEST_TIMEOUT, ClerkRequestError, makeClerkApi } from "./clerk-api"

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

/** A Clerk Backend API whose every answer is `respond`'s, recording each request's auth header. */
const fakeClerk = (respond: () => Response | Promise<Response>) => {
	const authorizations: Array<string | undefined> = []
	const http = Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) =>
			Effect.promise(async () => {
				authorizations.push(request.headers["authorization"])
				return HttpClientResponse.fromWeb(request, await respond())
			}),
		),
	)
	return { api: makeClerkApi(Redacted.make("sk_test_fake"), http), authorizations }
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const organization = {
	object: "organization",
	id: "org_test",
	name: "Maple",
	slug: "maple",
	has_image: false,
	max_allowed_memberships: 5,
	admin_delete_enabled: true,
	public_metadata: {},
	created_at: 0,
	updated_at: 0,
}

describe("ClerkApi.run", () => {
	it.effect("runs the operation with the secret key, under the client span the service map reads", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const { api, authorizations } = fakeClerk(() => json(200, organization))

			const org = yield* api
				.run(Clerk.getOrganization({ organization_id: "org_test" }))
				.pipe(Effect.withTracer(tracer))

			assert.strictEqual(org.name, "Maple")
			assert.deepStrictEqual(authorizations, ["Bearer sk_test_fake"])
			const span = Option.getOrUndefined(
				Arr.findFirst(
					spans,
					(candidate) => candidate.attributes.get("server.address") === "api.clerk.com",
				),
			)
			assert.isDefined(span)
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("peer.service"), "clerk")
		}),
	)

	it.effect("keeps Clerk's status and message on an error answer", () =>
		Effect.gen(function* () {
			const { api } = fakeClerk(() =>
				json(404, { errors: [{ code: "resource_not_found", message: "not found" }] }),
			)

			const error = yield* Effect.flip(api.run(Clerk.getUser({ user_id: "user_gone" })))

			assert.instanceOf(error, ClerkRequestError)
			assert.strictEqual(error.status, 404)
			assert.strictEqual(error.message, "not found")
		}),
	)

	it.effect("makes one attempt, so a create whose answer was lost is never replayed", () =>
		Effect.gen(function* () {
			const { api, authorizations } = fakeClerk(() =>
				json(503, { errors: [{ code: "unavailable", message: "try later" }] }),
			)

			const error = yield* Effect.flip(api.run(Clerk.createOrganization({ name: "Acme" })))

			assert.strictEqual(error.status, 503)
			assert.strictEqual(authorizations.length, 1)
		}),
	)

	it.effect("fails a stalled call as a typed request error once the timeout passes", () =>
		Effect.gen(function* () {
			const { api } = fakeClerk(() => new Promise<Response>(() => {}))
			const fiber = yield* Effect.forkChild(
				Effect.flip(api.run(Clerk.getOrganization({ organization_id: "org_test" }))),
			)
			yield* TestClock.adjust(CLERK_REQUEST_TIMEOUT)
			const error = yield* Fiber.join(fiber)
			assert.instanceOf(error, ClerkRequestError)
			assert.include(error.message, "timed out")
		}),
	)
})
