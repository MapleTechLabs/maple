/**
 * The `send_email` descriptor for api and alerting. Bind on prd only (`bindEmailSender`): other
 * stages run the same crons against live data and would email real users twice.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import { NOTIFICATIONS_SENDER_ADDRESS } from "../env.ts"

export const NotificationsEmail = Cloudflare.Email.SendEmail("email", {
	allowedSenderAddresses: [NOTIFICATIONS_SENDER_ADDRESS],
})
