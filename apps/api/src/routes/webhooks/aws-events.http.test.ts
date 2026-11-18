import { assert, describe, it } from "@effect/vitest"
import { IntegrationsPersistenceError } from "@maple/domain/http"
import { AwsAccountId, AwsConnectionId, OrgId } from "@maple/primitives"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import type { RateLimitOutcome } from "@maple/backend/services/auth/ApiV2RateLimiter"
import { AwsEventsRateLimiter } from "@maple/backend/services/cloud-security/AwsEventsRateLimiter"
import {
	CloudSecurityEventRejected,
	CloudSecurityEventsService,
	type CloudSecurityEventSender,
} from "@maple/backend/services/cloud-security/CloudSecurityEventsService"
import { AwsEventsRouter } from "./aws-events.http"

const orgId = Schema.decodeSync(OrgId)("org_sec")
const connectionId = Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
const sender: CloudSecurityEventSender = {
	connectionId,
	orgId,
	accountId: Schema.decodeSync(AwsAccountId)("111111111111"),
	modules: ["security"],
	verifiedAt: 1,
}

const ROUTE = `/api/integrations/aws/events/${connectionId}`
const KEY = { "x-maple-events-key": "key" }

/** One receiver over a stubbed service and limiter, with what each was asked. */
const makeReceiver = (limit: RateLimitOutcome = "allowed") => {
	const asked = { authenticated: 0, limited: 0, accepted: 0, bodyReads: 0 }
	// The service decides; the route turns each answer into the status EventBridge acts on.
	const events = CloudSecurityEventsService.of({
		eventsKey: () => Effect.succeed("key"),
		authenticate: (rawConnectionId, key) => {
			asked.authenticated += 1
			if (rawConnectionId !== connectionId)
				return Effect.fail(
					new CloudSecurityEventRejected({
						message: "Unknown events endpoint",
						reason: "unknown_connection",
					}),
				)
			if (key !== "key")
				return Effect.fail(
					new CloudSecurityEventRejected({ message: "Invalid events key", reason: "bad_key" }),
				)
			return Effect.succeed(sender)
		},
		accept: (_sender, body) => {
			asked.accepted += 1
			if (body === "down") return Effect.fail(new IntegrationsPersistenceError({ message: "down" }))
			if (body === "{")
				return Effect.fail(
					new CloudSecurityEventRejected({ message: "Malformed event", reason: "malformed" }),
				)
			return Effect.succeed({
				outcome: body === "stray" ? "ignored" : "stored",
				reason: body === "stray" ? "not_a_finding_event" : null,
				orgId,
				findings: body === "stray" ? 0 : 1,
				skipped: 0,
			})
		},
	})
	const limiter = AwsEventsRateLimiter.of({
		check: () =>
			Effect.sync(() => {
				asked.limited += 1
				return limit
			}),
	})
	const { handler } = HttpRouter.toWebHandler(
		AwsEventsRouter.pipe(
			Layer.provide(Layer.succeed(CloudSecurityEventsService, events)),
			Layer.provide(Layer.succeed(AwsEventsRateLimiter, limiter)),
		),
		{ disableLogger: true },
	)
	const send = (path: string, body: string, headers: Record<string, string> = {}) =>
		Effect.promise(() => {
			// Nothing is queued ahead of a read, so a pull means the route asked for the body.
			const stream = new ReadableStream<Uint8Array>(
				{
					pull: (controller) => {
						asked.bodyReads += 1
						controller.enqueue(new TextEncoder().encode(body))
						controller.close()
					},
				},
				{ highWaterMark: 0 },
			)
			// A streamed body has to say it is sent one way; the workers request type has no field for it.
			const init: RequestInit & { readonly duplex: "half" } = {
				method: "POST",
				body: stream,
				headers,
				duplex: "half",
			}
			return handler(new Request(`http://api.localhost${path}`, init), Context.empty())
		})
	return { asked, send }
}

describe("AwsEventsRouter", () => {
	it.effect("answers each delivery with the status EventBridge acts on", () =>
		Effect.gen(function* () {
			const { send } = makeReceiver()
			assert.strictEqual((yield* send(ROUTE, "event", KEY)).status, 200)
			// Acknowledged, so EventBridge does not retry an event Maple does not keep.
			assert.strictEqual((yield* send(ROUTE, "stray", KEY)).status, 200)
			// Refusals EventBridge must not retry.
			assert.strictEqual((yield* send(ROUTE, "event", { "x-maple-events-key": "other" })).status, 403)
			assert.strictEqual((yield* send("/api/integrations/aws/events/c-2", "event", KEY)).status, 404)
			assert.strictEqual((yield* send(ROUTE, "{", KEY)).status, 400)
			// A storage failure is retried.
			assert.strictEqual((yield* send(ROUTE, "down", KEY)).status, 503)
		}),
	)

	it.effect("refuses a delivery without a key before looking anything up or reading its body", () =>
		Effect.gen(function* () {
			const { asked, send } = makeReceiver()
			assert.strictEqual((yield* send(ROUTE, "event")).status, 403)
			assert.deepStrictEqual(asked, { authenticated: 0, limited: 0, accepted: 0, bodyReads: 0 })
		}),
	)

	it.effect("spends none of a connection's budget, and reads no body, on a wrong key", () =>
		Effect.gen(function* () {
			const { asked, send } = makeReceiver()
			assert.strictEqual((yield* send(ROUTE, "event", { "x-maple-events-key": "other" })).status, 403)
			assert.deepStrictEqual(asked, { authenticated: 1, limited: 0, accepted: 0, bodyReads: 0 })
			// An accepted key is counted once, and only then is the body read.
			assert.strictEqual((yield* send(ROUTE, "event", KEY)).status, 200)
			assert.deepStrictEqual(asked, { authenticated: 2, limited: 1, accepted: 1, bodyReads: 1 })
		}),
	)

	it.effect("answers 429, which EventBridge retries, once a connection is over its budget", () =>
		Effect.gen(function* () {
			const { asked, send } = makeReceiver("limited")
			assert.strictEqual((yield* send(ROUTE, "event", KEY)).status, 429)
			assert.deepStrictEqual(asked, { authenticated: 1, limited: 1, accepted: 0, bodyReads: 0 })
		}),
	)

	it.effect("keeps receiving when the limiter is unavailable", () =>
		Effect.gen(function* () {
			const { send } = makeReceiver("failed_open")
			assert.strictEqual((yield* send(ROUTE, "event", KEY)).status, 200)
		}),
	)
})
