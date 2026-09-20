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
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { resolveConnectorConfig } from "../config.ts"
import { InboundHandler } from "../inbound.ts"

/**
 * This deployment has credentials for no such connector, so it cannot verify
 * who is calling and must not pretend to have accepted anything.
 *
 * A typed failure rather than an early return, so it travels THROUGH the span
 * and leaves it `Error`: a 503 is a 5xx, and the repo's rule puts only 4xx
 * rejections on an `Ok` span. Absent credentials are also the state that makes
 * a webhook connector reject every request in silence, which is exactly what a
 * failed span is for.
 */
class ConnectorUnavailable extends Schema.TaggedError<ConnectorUnavailable>()(
	"@maple/chat-bot/ConnectorUnavailable",
	{ connector: Schema.String, missing: Schema.Array(Schema.String) },
) {}

const problem = (status: number, detail: string) =>
	Effect.as(
		Effect.annotateCurrentSpan("http.response.status_code", status),
		HttpServerResponse.text(detail, { status }),
	)

/** A rejection the caller caused: annotated, answered, and NOT failed through the span. */
const rejectCaller = (status: number, errorType: string, detail: string) =>
	Effect.annotateCurrentSpan("error.type", errorType).pipe(Effect.andThen(problem(status, detail)))

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
					const connectorId = params.connectorId ?? ""
					// Annotated BEFORE the lookup, so the two rejections below are
					// attributable to the id that was asked for rather than anonymous.
					yield* Effect.annotateCurrentSpan("maple.chat.connector", connectorId)

					const connector = registry.find((candidate) => candidate.id === connectorId)
					if (connector === undefined || connector.ingress.kind !== "webhook") {
						return yield* rejectCaller(404, "ConnectorNotFound", "No such connector")
					}

					const config = resolveConnectorConfig(env, connector)
					if (config._tag === "missing") {
						return yield* new ConnectorUnavailable({
							connector: connectorId,
							missing: config.names,
						})
					}

					const result = yield* connector.ingress.handle(request, config.config)
					yield* Effect.forEach(result.events, (event) => inbound.handle(event), {
						discard: true,
					})
					return result.response
				}).pipe(
					// A payload the connector rejected is the caller's problem, not
					// this service's: per OTEL HTTP semconv the span stays `Ok`.
					Effect.catchTag("@maple/chat-platform/ConnectorIngressError", (error) =>
						rejectCaller(400, error._tag, error.message),
					),
					// The 503 does the opposite: annotated while the span is current,
					// then allowed through it so the span carries `Error`, and only
					// turned into a response outside.
					Effect.tapError((error) =>
						Effect.logWarning("Chat connector webhook is not configured").pipe(
							Effect.annotateLogs({
								"maple.chat.connector": error.connector,
								"maple.chat.missing_config": error.missing.join(","),
							}),
							Effect.andThen(
								Effect.annotateCurrentSpan({
									"error.type": error._tag,
									"http.response.status_code": 503,
								}),
							),
						),
					),
					Effect.withSpan("chat_bot.connector_webhook"),
					Effect.catchTag("@maple/chat-bot/ConnectorUnavailable", () =>
						Effect.succeed(
							HttpServerResponse.text("Connector is not configured", { status: 503 }),
						),
					),
				),
			)
		}),
	)
