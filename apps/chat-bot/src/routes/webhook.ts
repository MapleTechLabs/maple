/**
 * `POST /connectors/:connectorId/webhook` — the one route every webhook-delivered
 * chat platform arrives on.
 *
 * The route resolves the connector by id and hands it the request. It does not
 * verify a signature, parse a body or know a payload: a connector that cannot
 * authenticate its own caller is a connector that has not been written yet.
 *
 * Nothing registered today delivers this way — the first connector is a socket
 * one — so this exists as the contract's other half, tested against a fake
 * connector. It is also why the Worker takes no public hostname yet; see
 * `../worker.ts`.
 */
import type { ChatConnector } from "@maple/chat-platform"
import { connectors as registeredConnectors } from "@maple/chat-platform/connectors"
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { resolveConnectorConfig } from "../config.ts"
import { InboundHandler } from "../inbound.ts"

const problem = (status: number, detail: string) =>
	Effect.as(
		Effect.annotateCurrentSpan("http.response.status_code", status),
		HttpServerResponse.text(detail, { status }),
	)

export const connectorWebhookRouter = (
	env: Record<string, unknown>,
	registry: ReadonlyArray<ChatConnector> = registeredConnectors,
) =>
	HttpRouter.use((router) =>
		Effect.gen(function* () {
			const inbound = yield* InboundHandler

			yield* router.add("POST", "/connectors/:connectorId/webhook", (request) =>
				Effect.gen(function* () {
					const params = yield* HttpRouter.params
					const connectorId = params.connectorId
					const connector = registry.find((candidate) => candidate.id === connectorId)
					if (connector === undefined || connector.ingress.kind !== "webhook") {
						return yield* problem(404, "No such connector")
					}
					yield* Effect.annotateCurrentSpan("maple.chat.connector", connector.id)

					const config = resolveConnectorConfig(env, connector)
					// Configured off rather than broken: this deployment has no
					// credentials for the platform, so it cannot verify the caller and
					// must not pretend to have accepted anything.
					if (config._tag === "missing") {
						return yield* problem(503, "Connector is not configured")
					}

					const result = yield* connector.ingress.handle(request, config.config)
					for (const event of result.events) {
						yield* inbound.handle(event)
					}
					return result.response
				}).pipe(
					// A payload the connector rejected is the caller's problem, not
					// this service's: per OTEL HTTP semconv the span stays `Ok`.
					Effect.catchTag("@maple/chat-platform/ConnectorIngressError", (error) =>
						problem(400, error.message),
					),
					Effect.withSpan("chat_bot.connector_webhook"),
				),
			)
		}),
	)
