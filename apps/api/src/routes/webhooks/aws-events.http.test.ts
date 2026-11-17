import { assert, describe, it } from "@effect/vitest"
import { IntegrationsPersistenceError } from "@maple/domain/http"
import { OrgId } from "@maple/primitives"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import {
	CloudSecurityEventRejected,
	CloudSecurityEventsService,
} from "@maple/backend/services/cloud-security/CloudSecurityEventsService"
import { AwsEventsRouter } from "./aws-events.http"

const orgId = Schema.decodeSync(OrgId)("org_sec")

// The service decides; the route turns each answer into the status EventBridge acts on.
const stubbed = CloudSecurityEventsService.of({
	eventsKey: () => Effect.succeed("key"),
	receive: (connectionId, key, body) => {
		if (body === "down") return Effect.fail(new IntegrationsPersistenceError({ message: "down" }))
		if (connectionId !== "c-1")
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

const send = (path: string, body: string, headers: Record<string, string> = {}) =>
	Effect.promise(() => {
		const { handler } = HttpRouter.toWebHandler(
			AwsEventsRouter.pipe(Layer.provide(Layer.succeed(CloudSecurityEventsService, stubbed))),
			{ disableLogger: true },
		)
		return handler(
			new Request(`http://api.localhost${path}`, { method: "POST", body, headers }),
			Context.empty(),
		)
	})

describe("AwsEventsRouter", () => {
	it.effect("answers each delivery with the status EventBridge acts on", () =>
		Effect.gen(function* () {
			const key = { "x-maple-events-key": "key" }
			const route = "/api/integrations/aws/events/c-1"
			assert.strictEqual((yield* send(route, "event", key)).status, 200)
			// Acknowledged, so EventBridge does not retry an event Maple does not keep.
			assert.strictEqual((yield* send(route, "stray", key)).status, 200)
			// Refusals EventBridge must not retry.
			assert.strictEqual((yield* send(route, "event", { "x-maple-events-key": "other" })).status, 403)
			assert.strictEqual((yield* send(route, "event")).status, 403)
			assert.strictEqual((yield* send("/api/integrations/aws/events/c-2", "event", key)).status, 404)
			assert.strictEqual((yield* send(route, "{", key)).status, 400)
			// A storage failure is retried.
			assert.strictEqual((yield* send(route, "down", key)).status, 503)
		}),
	)
})
