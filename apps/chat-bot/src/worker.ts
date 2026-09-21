/**
 * The chat-bot Worker in alchemy's single-module form: this file is both the
 * resource the root stack yields (`yield* ChatBot`) and the bundle alchemy
 * deploys (`main: import.meta.url`).
 *
 * It hosts connector INGRESS, generically. Everything vendor-specific lives in
 * `@maple/chat-platform`'s connector directories; this Worker knows only that
 * some connectors arrive over a socket and some over an HTTP request, and it
 * provides both. Adding a chat platform adds no Worker, no Durable Object class
 * and no infrastructure here.
 *
 * Two surfaces:
 *
 *   - **Sockets.** One `ConnectorSocket` Durable Object per socket-ingress
 *     connector, addressed by the connector's id. A minute cron is what starts
 *     and re-starts them; the object's own alarm keeps each one alive between
 *     ticks.
 *   - **Webhooks.** `POST /connectors/:connectorId/webhook`, dispatched by id.
 *
 * A normalized event reaches `InboundHandler`, which records it and hands it to
 * the conversation's own `ConnectorRelay` object — where the turn is claimed on
 * the agent's chat session and the answer is streamed back. The ingress half
 * never waits for any of that.
 *
 * **No public hostname.** The socket half dials out and needs none, and no
 * webhook connector is registered yet — so a custom domain would be DNS, a
 * certificate and a `MapleDomains` entry bought for a route nothing calls. Under
 * `bun dev` the portless route reaches it; the first webhook connector is what
 * should buy the hostname.
 */
import { connectors } from "@maple/chat-platform/connectors"
import {
	cachedRecoverable,
	CLOUDFLARE_WORKER_PLACEMENT,
	MapleDb,
	MapleStack,
	type MapleStage,
	resolveWorkerName,
} from "@maple/infra/cloudflare"
import { merge, optionalSecret, plainWithDefault, selfObservabilityEnv } from "@maple/infra/env"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer, Ref, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { resolveConnectorConfig, socketConnectors, type IngressConnector } from "./config.ts"
import { InboundHandler } from "./inbound.ts"
import { connectorConfigEnv } from "./resources/env.ts"
import { connectorWebhookRouter } from "./routes/webhook.ts"
import { ConnectorRelayLive, ConnectorRelayObject } from "./relay/ConnectorRelay.ts"
import { ConnectorSocketLive, ConnectorSocketObject } from "./socket/ConnectorSocket.ts"

/**
 * Everything in this Worker's env that comes from configuration.
 *
 * `connectorConfigEnv` is the registry's own declarations, bound as optional
 * values: a stage without a platform's credentials deploys and runs, and that
 * connector is skipped.
 */
const configuredEnv = (stage: MapleStage) =>
	merge(
		selfObservabilityEnv(stage),
		connectorConfigEnv,
		// Where a relayed answer's links point, and what signs the image of a chart the agent drew.
		// The key is optional here where the API requires it: without one a reply carries its charts
		// as text, which is what `chatChartImageUrl` answers `null` for.
		plainWithDefault("MAPLE_APP_BASE_URL", "https://app.maple.dev"),
		optionalSecret("MAPLE_SHARE_TOKEN_HMAC_KEY"),
	)

/**
 * Alchemy evaluates a Worker's props wherever the class is yielded — the
 * deployed bundle included, where they are inert. `__ALCHEMY_RUNTIME__` folds to
 * `true` there, so the stack-side branch below, and the `@maple/infra` modules
 * only it reaches, are dead-code-eliminated from what ships.
 */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, workerDev, devEnv } = yield* MapleStack
	const env = yield* configuredEnv(stage)
	return {
		main: import.meta.url,
		name: resolveWorkerName("chat-bot", stage),
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		// Under `bun dev`: a sticky port the app's route follows.
		dev: workerDev("chat-bot"),
		// See the module comment: nothing calls in from the public internet yet.
		workersDev: false,
		// `devEnv` last, so `.env.local` cannot override the inter-app URLs.
		env: {
			// Cross-script reference to the chat Durable Object the AI Worker hosts: a mention
			// becomes a turn on it, and `chatSessionStub` reads it off `env` under the class name.
			ChatSession: Cloudflare.DurableObject("ChatSession", {
				className: "ChatSession",
				scriptName: resolveWorkerName("ai", stage),
			}),
			...env,
			...devEnv,
		},
	}
})

/**
 * The trigger.
 *
 * A minute cron rather than a first-request hook, because this Worker has no
 * traffic of its own: nothing would ever make the first request. It is also the
 * recovery path — after a deploy, an eviction or a Durable Object that lost its
 * alarm, the next tick brings the connection back — and `ensureConnected` is
 * idempotent, so a tick against a healthy connection is one storage read.
 */
const CONNECT_CRON = "* * * * *"

export class ChatBot extends Cloudflare.Worker<
	ChatBot,
	Cloudflare.WorkerShape,
	ConnectorSocketObject | ConnectorRelayObject
>()("chat-bot") {}

export default ChatBot.make(
	props,
	Effect.gen(function* () {
		// Yielding the class is what binds it, registers it at plan time and
		// exports it from the generated entry.
		const sockets = yield* ConnectorSocketObject
		// Bound but never called from here: the socket object reaches a conversation's relay off its
		// own env, and this is what puts the namespace there and the class in the entry's exports.
		yield* ConnectorRelayObject
		// `MAPLE_DB` in the stage's flavor. One row per mention — the workspace this event's
		// conversation belongs to — so it shares the api's Hyperdrive config rather than taking one.
		yield* MapleDb("chat-bot")
		const env = yield* Cloudflare.WorkerEnvironment

		// One log line per connector that cannot run, once per isolate rather than
		// once a minute.
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
				(connector) => {
					const config = resolveConnectorConfig(env, connector)
					return config._tag === "missing"
						? announceSkip(connector, config.names)
						: sockets.getByName(connector.id).ensureConnected(connector.id)
				},
				{ discard: true },
			),
		)

		// Built on the first request and kept for the isolate — not in init, which
		// also runs at plan time, where alchemy would bind every `Config` it saw
		// read onto the Worker as a secret. The build scope is never closed:
		// workerd has no isolate teardown, so nothing in the layer may need
		// releasing.
		const app = yield* cachedRecoverable(
			Effect.gen(function* () {
				const scope = yield* Scope.make()
				return yield* HttpRouter.toHttpEffect(
					connectorWebhookRouter(env).pipe(
						Layer.provideMerge(InboundHandler.layer(env)),
						Layer.provideMerge(HttpRouter.layer),
					),
				).pipe(Scope.provide(scope))
			}).pipe(Effect.orDie),
		)

		return { fetch: app }
	}).pipe(
		// The Worker's init IS the entry point: the cron source needs the host
		// Worker, and the bridge builds telemetry into each event's scope — a cron
		// fire included — and flushes it after.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				// The host Worker's layer also provides the Durable Objects'
				// implementations; yielding the classes above is what forces this to run,
				// so they reach the generated entry's exports.
				ConnectorSocketLive,
				ConnectorRelayLive,
				Cloudflare.Hyperdrive.ConnectBinding,
				Cloudflare.Workers.CronEventSourceLive,
				WorkerTelemetry({ serviceName: "maple-chat-bot" }),
			),
		),
	),
)
