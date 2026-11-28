import { assert, describe, it } from "@effect/vitest"
import { IntegrationsPersistenceError } from "@maple/domain/http"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import {
	GcpSecurityEventRejected,
	GcpSecurityEventsService,
} from "@maple/backend/services/cloud-security/GcpSecurityEventsService"
import { GcpSecurityEventsRouter } from "./gcp-security.http"

const CONNECTOR = "0d3c6f1e-6b8f-4e6b-9a1e-2f4c5d6e7f80"
const ROUTE = `/api/integrations/gcp/security/${CONNECTOR}`

/** One receiver over a stubbed service: the route turns each answer into the status Pub/Sub acts on. */
const makeReceiver = () => {
	const seen: Array<{ readonly connector: string; readonly token: string; readonly body: string }> = []
	const events = GcpSecurityEventsService.of({
		accept: (connector, token, body) => {
			seen.push({ connector, token, body })
			if (connector !== CONNECTOR)
				return Effect.fail(
					new GcpSecurityEventRejected({
						message: "No such connector",
						reason: "unknown_connector",
					}),
				)
			if (token !== "good")
				return Effect.fail(
					new GcpSecurityEventRejected({ message: "Invalid push token", reason: "bad_token" }),
				)
			if (body === "down") return Effect.fail(new IntegrationsPersistenceError({ message: "down" }))
			if (body === "{")
				return Effect.fail(
					new GcpSecurityEventRejected({ message: "Body is not JSON", reason: "malformed" }),
				)
			return Effect.succeed(
				body === "off"
					? { outcome: "ignored", reason: "security_off" }
					: { outcome: "stored", reason: null },
			)
		},
	})
	const { handler } = HttpRouter.toWebHandler(
		GcpSecurityEventsRouter.pipe(Layer.provide(Layer.succeed(GcpSecurityEventsService, events))),
		{ disableLogger: true },
	)
	const send = (path: string, body: string, headers: Record<string, string> = {}) =>
		Effect.promise(async () => {
			const response = await handler(
				new Request(`http://api.localhost${path}`, { method: "POST", body, headers }),
				Context.empty(),
			)
			return { status: response.status, text: await response.text() }
		})
	return { seen, send }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe("GcpSecurityEventsRouter", () => {
	it.effect(
		"hands the connector, token and body to the service and acknowledges what it kept or dropped",
		() =>
			Effect.gen(function* () {
				const receiver = makeReceiver()
				assert.deepStrictEqual(yield* receiver.send(ROUTE, "{}", bearer("good")), {
					status: 200,
					text: "ok",
				})
				assert.deepStrictEqual(yield* receiver.send(ROUTE, "off", bearer("good")), {
					status: 200,
					text: "ignored",
				})
				assert.deepStrictEqual(receiver.seen[0], { connector: CONNECTOR, token: "good", body: "{}" })
			}),
	)

	it.effect("answers the statuses Pub/Sub retries on, or stops on", () =>
		Effect.gen(function* () {
			const receiver = makeReceiver()
			const statuses = yield* Effect.forEach(
				[
					receiver.send(ROUTE, "{}"),
					receiver.send(ROUTE, "{}", { authorization: "Basic abc" }),
					receiver.send(ROUTE, "{}", bearer("forged")),
					receiver.send("/api/integrations/gcp/security/other", "{}", bearer("good")),
					receiver.send(ROUTE, "{", bearer("good")),
					receiver.send(ROUTE, "down", bearer("good")),
				],
				(send) => Effect.map(send, (response) => response.status),
			)
			assert.deepStrictEqual(statuses, [403, 403, 403, 404, 400, 503])
			// Without a bearer token the service is never asked.
			assert.lengthOf(receiver.seen, 4)
		}),
	)
})
