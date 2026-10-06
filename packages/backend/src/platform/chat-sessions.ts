/**
 * The `ChatSession` Durable Object as alchemy binds it, and the `ChatSessions` port over it.
 *
 * maple-ai hosts the class (`ChatSessionObject.make`); api, alerting and chat-bot bind it
 * cross-script from their inits (`bindChatSessions`). Either way a graph reaches it through the
 * `ChatSessions` port, never off `env`.
 */
import { chatSessionClient, type ChatSessionRpc } from "@maple/domain/chat-session-stub"
import { parseMapleDeploymentEffect, resolveWorkerName } from "@maple/infra/cloudflare"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import * as Cloudflare from "alchemy/Cloudflare"
import { Stage } from "alchemy/Stage"
import { Config, Context, Effect, Layer, Option } from "effect"
import { ChatSessions } from "./bindings"

/**
 * The Durable Object: one per `"<orgId>:<tabId>"`, SQLite-backed, hosted by maple-ai.
 *
 * `transferredFrom` names apps/api, which hosted this class until the agent surfaces moved to
 * maple-ai. Alchemy turns that into a data-preserving `transferred_classes` migration, so live
 * transcripts follow the class rather than being stranded in a namespace nothing binds any more.
 * Without it the api's own deploy fails with `DurableObjectTransferRequired`, because dropping a
 * locally hosted class while keeping a cross-script reference to it is exactly the shape that
 * silently destroys a namespace, and alchemy refuses it before any upload.
 *
 * It is inert once every stage has transferred (a fresh stage creates the class outright), so it
 * stays rather than being cleaned up later and breaking whichever stage lagged behind. A
 * cross-script binding (`from`) ignores it.
 */
export class ChatSessionObject extends Cloudflare.DurableObject<ChatSessionObject, ChatSessionRpc>()(
	"ChatSession",
	{ transferredFrom: "api" },
) {}

/** The namespace client alchemy hands out, as far as the port reads it. */
export interface ChatSessionNamespace {
	readonly getByName: (name: string) => ChatSessionRpc
	readonly jurisdiction: (jurisdiction: "eu") => ChatSessionNamespace
}

/**
 * maple-ai's script name, which the cross-script binding names at plan time. `resolveWorkerName`
 * rather than the ai Worker's output on purpose: consuming the output would make the binder's
 * deploy wait on ai's, and a reference-only binding needs no such ordering. Unread in the isolate,
 * where the binding is already on the env.
 */
const aiScriptName = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return ""
	const { stage, region } = yield* parseMapleDeploymentEffect(yield* Stage)
	return resolveWorkerName("ai", stage, region)
	// The root stack parses the same stage first and fails typed there.
}).pipe(Effect.orDie)

/** Bind maple-ai's `ChatSession` from a Worker's init. */
export const bindChatSessions = Effect.flatMap(aiScriptName, (scriptName) =>
	ChatSessionObject.from(scriptName),
)

/**
 * The namespace a Worker bound, for a Durable Object activation of its own to yield (an alchemy
 * class is not a Context tag, so a bound client reaches an activation through this one).
 */
export class BoundChatSessions extends Context.Service<BoundChatSessions, ChatSessionNamespace>()(
	"@maple/api/platform/BoundChatSessions",
) {
	static readonly layer = Layer.effect(this, bindChatSessions)
}

/**
 * The port over a namespace client. On the EU instance (`MAPLE_REGION=eu`, which the stack derives
 * and the environment cannot override) ids are minted through the `eu` jurisdiction, so a
 * session's transcript is stored only in EU data centres. Jurisdiction is a property of the id, so
 * it is applied where ids are minted, not on the binding. The region resolves through the env's
 * `ConfigProvider`.
 */
export const chatSessionsLayer = (namespace: ChatSessionNamespace, env: Record<string, unknown>) =>
	Layer.effect(
		ChatSessions,
		Effect.gen(function* () {
			const region = yield* Config.option(Config.String("MAPLE_REGION"))
			const addressed = Option.contains(region, "eu") ? namespace.jurisdiction("eu") : namespace
			return { session: (sessionId: string) => chatSessionClient(addressed.getByName(sessionId)) }
		}).pipe(Effect.orDie),
	).pipe(Layer.provide(workerEnvLayer(env)))

/** The port where a namespace was handed over, nothing where it was not: services read it through `serviceOption`. */
export const chatSessionsLayerIfBound = (
	namespace: ChatSessionNamespace | undefined,
	env: Record<string, unknown>,
) => (namespace === undefined ? Layer.empty : chatSessionsLayer(namespace, env))
