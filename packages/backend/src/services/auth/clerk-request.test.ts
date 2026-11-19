import * as Clerk from "@distilled.cloud/clerk"
import { assert, describe, it } from "@effect/vitest"
import { makeClerkApi } from "@maple/auth"
import { Effect, Fiber, Layer, Option, Redacted, Tracer, Array as Arr } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { CLERK_REQUEST_TIMEOUT, ClerkRequestError, clerkRequest } from "./clerk-request"

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

describe("clerkRequest", () => {
	it.effect("runs the operation with the secret key under a Client-kind Clerk span", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const { api, authorizations } = fakeClerk(() => json(200, organization))

			const org = yield* clerkRequest(
				api,
				"Clerk.organizations.getOrganization",
				{ orgId: "org_test" },
				Clerk.getOrganization({ organization_id: "org_test" }),
			).pipe(Effect.withTracer(tracer))

			assert.strictEqual(org.name, "Maple")
			assert.deepStrictEqual(authorizations, ["Bearer sk_test_fake"])
			const span = Option.getOrUndefined(
				Arr.findFirst(spans, (candidate) => candidate.name === "Clerk.organizations.getOrganization"),
			)
			assert.isDefined(span)
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("peer.service"), "clerk")
			assert.strictEqual(span.attributes.get("orgId"), "org_test")
		}),
	)

	it.effect("keeps Clerk's status and message on an error answer", () =>
		Effect.gen(function* () {
			const { api } = fakeClerk(() =>
				json(404, { errors: [{ code: "resource_not_found", message: "not found" }] }),
			)

			const error = yield* Effect.flip(
				clerkRequest(api, "Clerk.users.getUser", {}, Clerk.getUser({ user_id: "user_gone" })),
			)

			assert.instanceOf(error, ClerkRequestError)
			assert.strictEqual(error.operation, "Clerk.users.getUser")
			assert.strictEqual(error.status, 404)
			assert.strictEqual(error.message, "not found")
		}),
	)

	it.effect("fails a stalled call as a typed request error once the timeout passes", () =>
		Effect.gen(function* () {
			const { api } = fakeClerk(() => new Promise<Response>(() => {}))
			const fiber = yield* Effect.forkChild(
				Effect.flip(
					clerkRequest(
						api,
						"Clerk.organizations.getOrganization",
						{},
						Clerk.getOrganization({ organization_id: "org_test" }),
					),
				),
			)
			yield* TestClock.adjust(CLERK_REQUEST_TIMEOUT)
			const error = yield* Fiber.join(fiber)
			assert.instanceOf(error, ClerkRequestError)
			assert.include(error.message, "timed out")
		}),
	)
})
