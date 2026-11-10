/**
 * The `send_email` binding as the {@link EmailSender} port, for the Workers that send mail (api,
 * alerting). Bound on prd only (`bindNotificationsEmail`); every non-prd isolate reads none.
 */
import { bindNotificationsEmail } from "@maple/infra/cloudflare"
import { dischargeRuntimeContext } from "@maple/infra/worker-runtime"
import type * as Cloudflare from "@alchemy.run/cloudflare"
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
export const bindEmailSender = Effect.map(bindNotificationsEmail, Option.map(toPort))
