/**
 * The `send_email` binding as the {@link EmailSender} port, for the Workers that send mail (api, alerting).
 *
 * Production only: every other stage runs the same email crons against live org data, so a binding
 * there would send real users a second copy. The stage is known only at plan time; in the isolate
 * the binding is either on the env or not, and every non-prd isolate reads none.
 */
import { NotificationsEmail, parseMapleDeployment } from "@maple/infra/cloudflare"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { dischargeRuntimeContext } from "./alchemy-runtime"
import { Stage } from "alchemy/Stage"
import { Effect, Option } from "effect"
import { EmailSendError, type EmailSenderClient } from "./bindings"

const toPort = (client: Cloudflare.Email.SendClient): EmailSenderClient => ({
	send: ({ replyTo, headers, ...message }) =>
		dischargeRuntimeContext(
			client.send({
				...message,
				...(replyTo === undefined ? undefined : { replyTo }),
				...(headers === undefined ? undefined : { headers: { ...headers } }),
			}),
		).pipe(
			Effect.mapBoth({
				onSuccess: (result) => ({ messageId: result.messageId }),
				onFailure: (error) => new EmailSendError({ message: error.message, cause: error.cause }),
			}),
		),
})

/** Yield from a Worker's init, with `Cloudflare.Email.SendBinding` provided; the value is {@link EmailSender}'s. */
export const bindEmailSender = Effect.gen(function* () {
	if (!globalThis.__ALCHEMY_RUNTIME__) {
		const stage = yield* Stage
		if (parseMapleDeployment(stage).stage.kind !== "prd") return Option.none<EmailSenderClient>()
	}
	const notificationsEmail = yield* NotificationsEmail
	const client = yield* Cloudflare.Email.Send(notificationsEmail)
	if (!globalThis.__ALCHEMY_RUNTIME__) return Option.none<EmailSenderClient>()
	const raw: unknown = yield* dischargeRuntimeContext(client.raw)
	return raw === undefined || raw === null ? Option.none<EmailSenderClient>() : Option.some(toPort(client))
})
