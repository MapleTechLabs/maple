/**
 * The `send_email` binding for api and alerting, on prd only: other stages run the same crons
 * against live data and would email real users twice.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { NOTIFICATIONS_SENDER_ADDRESS } from "../env.ts"
import { prdOnlyBinding } from "./stack.ts"
import { dischargeRuntimeContext } from "./worker-runtime.ts"

export const NotificationsEmail = Cloudflare.Email.SendEmail("email", {
	allowedSenderAddresses: [NOTIFICATIONS_SENDER_ADDRESS],
})

/** Yield from a Worker init with `Cloudflare.Email.SendBinding` provided; `None` off prd or unbound. */
export const bindNotificationsEmail = prdOnlyBinding(
	Effect.flatMap(NotificationsEmail, (email) => Cloudflare.Email.Send(email)),
	(client) =>
		Effect.map(dischargeRuntimeContext(client.raw), (raw: unknown) =>
			raw === undefined || raw === null ? Option.none() : Option.some(client),
		),
)
