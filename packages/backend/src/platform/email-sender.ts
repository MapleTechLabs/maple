/**
 * The `send_email` binding as the {@link EmailSender} port, for the Workers that send mail (api, alerting).
 *
 * Production only: every other stage runs the same email crons against live org data, so a binding
 * there would send real users a second copy. The stage is known only at plan time; in the isolate
 * the binding is either on the env or not, and every non-prd isolate reads none.
 */
import { NotificationsEmail, parseMapleDeployment } from "@maple/infra/cloudflare"
import * as Cloudflare from "alchemy/Cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { Stage } from "alchemy/Stage"
import { Effect, Option } from "effect"
import { EmailSendError, type EmailSenderClient } from "./bindings"

/** Discharge alchemy's phantom color, the way alchemy's own runtime helpers do. */
const runtime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>): Effect.Effect<A, E> =>
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.provide(effect, RuntimeContext.phantom)

const toPort = (client: Cloudflare.Email.SendClient): EmailSenderClient => ({
	send: ({ replyTo, ...message }) =>
		runtime(client.send(replyTo === undefined ? message : { ...message, replyTo })).pipe(
			Effect.map((result) => ({ messageId: result.messageId })),
			Effect.mapError((error) => new EmailSendError({ message: error.message, cause: error.cause })),
		),
})

/** Yield from a Worker's init, with `Cloudflare.Email.SendBinding` provided; the value is {@link EmailSender}'s. */
export const bindEmailSender = Effect.gen(function* () {
	if (!globalThis.__ALCHEMY_RUNTIME__ && parseMapleDeployment(yield* Stage).stage.kind !== "prd") {
		return Option.none<EmailSenderClient>()
	}
	const client = yield* Cloudflare.Email.Send(yield* NotificationsEmail)
	if (!globalThis.__ALCHEMY_RUNTIME__) return Option.none<EmailSenderClient>()
	const raw: unknown = yield* runtime(client.raw)
	return raw === undefined || raw === null ? Option.none<EmailSenderClient>() : Option.some(toPort(client))
})
