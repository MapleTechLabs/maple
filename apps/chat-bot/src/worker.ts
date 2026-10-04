/**
 * The chat-bot Worker: generic connector ingress (vendor code lives in
 * `@maple/chat-platform`). Sockets: one `ConnectorSocket` DO per connector, kept
 * up by a minute cron. Webhooks: `POST /connectors/:connectorId/webhook`. Events
 * go to `InboundHandler`, then the conversation's `ConnectorRelay` DO.
 */
import { connectors } from "@maple/chat-platform/connectors"
import {
	cachedRecoverable,
	MapleDb,
	mapleDbEnv,
	MapleStack,
	type MapleDomains,
	type MapleRegion,
	type MapleStage,
	resolveWorkerName,
	resolveWorkerPlacement,
} from "@maple/infra/cloudflare"
import { merge, optionalSecret, plainWithDefault, selfObservabilityEnv } from "@maple/infra/env"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer, Ref, Scope } from "effect"
import { HttpRouter } from "effect/http"
import { resolveConnectorConfig, socketConnectors, type IngressConnector } from "./config.ts"
import { InboundHandler } from "./inbound.ts"
import { connectorConfigEnv } from "./resources/env.ts"
import { connectorWebhookRouter } from "./routes/webhook.ts"
import { ConnectorRelayLive, ConnectorRelayObject } from "./relay/ConnectorRelay.ts"
import { ConnectorSocketLive, ConnectorSocketObject } from "./socket/ConnectorSocket.ts"

/** Config-sourced env. Connector config is optional: a connector without it is skipped. */
const configuredEnv = (stage: MapleStage, region: MapleRegion, domains: MapleDomains) =>
	merge(
		selfObservabilityEnv(stage, region),
		connectorConfigEnv,
		// App link base, and the chart-image signing key (without it charts render as text).
		plainWithDefault("MAPLE_APP_BASE_URL", `https://${domains.web ?? "app.maple.dev"}`),
		optionalSecret("MAPLE_SHARE_TOKEN_HMAC_KEY"),
		// Opens credentials a connector sealed on a workspace row; only those connectors need it.
		optionalSecret("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
	)

/** `__ALCHEMY_RUNTIME__` folds to `true` in the bundle, so the stack-side branch is tree-shaken. */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, region, domains, workerDev, devEnv, db } = yield* MapleStack
	const env = yield* configuredEnv(stage, region, domains)
	return {
		main: import.meta.url,
		name: resolveWorkerName("chat-bot", stage, region),
		compatibility: { date: "2026-10-01" },
		placement: resolveWorkerPlacement(region),
		dev: workerDev("chat-bot"),
		// Vendors store this webhook URL, so it must stay stable across deploys (prod only).
		workersDev: false,
		domain: domains.chat,
		// `devEnv` last, so `.env.local` cannot override the inter-app URLs.
		env: {
			// maple-ai's chat DO; mentions become turns on it (read off `env` by class name).
			ChatSession: Cloudflare.DurableObject("ChatSession", {
				className: "ChatSession",
				scriptName: resolveWorkerName("ai", stage, region),
			}),
			...mapleDbEnv(db, "chat-bot"),
			...env,
			...devEnv,
		},
	}
})

/** Starts and recovers sockets (no traffic would trigger a first request); `ensureConnected` is idempotent. */
const CONNECT_CRON = "* * * * *"

export class ChatBot extends Cloudflare.Worker<
	ChatBot,
	Cloudflare.WorkerShape,
	ConnectorSocketObject | ConnectorRelayObject
>()("chat-bot") {}

export default ChatBot.make(
	props,
	Effect.gen(function* () {
		// Yielding the hosted DOs binds, registers and exports them. Their hosting must not move.
		const sockets = yield* ConnectorSocketObject
		const relays = yield* ConnectorRelayObject
		// Light traffic, so it shares api's Hyperdrive config.
		yield* MapleDb("chat-bot")
		const env = yield* Cloudflare.WorkerEnvironment

		// Logged once per isolate, not once a minute.
		const announced = yield* Ref.make(new Set<string>())
		const announceSkip = Effect.fnUntraced(function* (
			connector: IngressConnector,
			names: ReadonlyArray<string>,
		) {
			if ((yield* Ref.get(announced)).has(connector.id)) return
			yield* Ref.update(announced, (seen) => new Set(seen).add(connector.id))
			yield* Effect.logInfo("Skipping chat connector with no configuration").pipe(
				Effect.annotateLogs({
					"maple.chat.connector": connector.id,
					"maple.chat.missing_config": names.join(","),
				}),
			)
		})

		yield* Cloudflare.Workers.cron(CONNECT_CRON, () =>
			Effect.forEach(
				socketConnectors(connectors),
				(connector) =>
					Effect.flatMap(resolveConnectorConfig(connector), (config) =>
						config._tag === "missing"
							? announceSkip(connector, config.names)
							: sockets.getByName(connector.id).ensureConnected(connector.id),
					),
				{ discard: true },
			).pipe(
				// Per fire, never in init: alchemy binds every `Config` it sees read at plan time.
				// oxlint-disable-next-line effecttsgo/strict-effect-provide
				Effect.provide(workerEnvLayer(env)),
			),
		)

		// Built on the first request, not in init (plan time would auto-bind every `Config`).
		// The scope is never closed, so nothing in the layer may need releasing.
		const app = yield* cachedRecoverable(
			Effect.gen(function* () {
				const scope = yield* Scope.make()
				return yield* HttpRouter.toHttpEffect(
					connectorWebhookRouter().pipe(
						Layer.provideMerge(InboundHandler.layer(relays)),
						Layer.provideMerge(HttpRouter.layer),
						Layer.provideMerge(workerEnvLayer(env)),
					),
				).pipe(Scope.provide(scope))
			}).pipe(Effect.orDie),
		)

		return { fetch: app }
	}).pipe(
		// The init is the entry point: the cron source needs the host Worker.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				// The socket DO's activation yields the relay namespace, so it builds on it.
				ConnectorSocketLive.pipe(Layer.provideMerge(ConnectorRelayLive)),
				Cloudflare.Hyperdrive.ConnectBinding,
				Cloudflare.Workers.CronEventSourceLive,
				WorkerTelemetry({ serviceName: "maple-chat-bot" }),
			),
		),
	),
)
