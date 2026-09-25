/**
 * The delivery entry point: pick the transport for the destination, hand it the
 * shared render input, run it under the uniform wrapper.
 *
 * The `Match` is what makes the registry exhaustive — adding a member to
 * `DestinationSecretConfig` fails to compile here until it has a transport.
 * It also narrows the config to the exact member each transport declares, which
 * is why no transport re-discriminates on `type` and no `any` is needed to hold
 * the transports in one collection.
 */
import type { AlertDeliveryFailure } from "@maple/domain/http"
import { Effect, Match } from "effect"
import { renderTitleBody } from "../AlertDeliveryDispatch"
import { discordTransport } from "./transports/discord"
import { chatTransport } from "./transports/chat"
import { emailTransport } from "./transports/email"
import { hazelTransport } from "./transports/hazel"
import { pagerDutyTransport } from "./transports/pagerduty"
import { telegramTransport } from "./transports/telegram"
import { webhookTransport } from "./transports/webhook"
import { runEffectTransport, runHttpTransport, type TransportRuntime } from "./runTransport"
import type { EffectTransportDeps, RenderInput } from "./Transport"
import type { DispatchContext, DispatchResult } from "./context"

export const dispatchDelivery = (
	context: DispatchContext,
	payloadJson: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
	linkUrl: string,
	chatUrl: string,
	/** `sendEmail` (the platform email channel) and `postChatAlert` (a chat connector). */
	deps: EffectTransportDeps,
): Effect.Effect<DispatchResult, AlertDeliveryFailure> => {
	const runtime: TransportRuntime = { fetchFn, timeoutMs }
	/**
	 * Resolved once here rather than by each provider: the template is a
	 * property of the rule and the destination TYPE, not of the transport's
	 * wire format.
	 */
	const templated = renderTitleBody(context, context.secretConfig.type, linkUrl, chatUrl)
	const shared = { context, linkUrl, chatUrl, payloadJson, templated }
	const input = <Config>(config: Config): RenderInput<Config> => ({ config, ...shared })

	return Match.value(context.secretConfig).pipe(
		Match.discriminatorsExhaustive("type")({
			pagerduty: (config) => runHttpTransport(pagerDutyTransport, input(config), runtime),
			webhook: (config) => runHttpTransport(webhookTransport, input(config), runtime),
			"hazel-oauth": (config) => runHttpTransport(hazelTransport, input(config), runtime),
			discord: (config) => runHttpTransport(discordTransport, input(config), runtime),
			telegram: (config) => runHttpTransport(telegramTransport, input(config), runtime),
			email: (config) => runEffectTransport(emailTransport, input(config), deps),
			chat: (config) => runEffectTransport(chatTransport, input(config), deps),
		}),
	)
}
