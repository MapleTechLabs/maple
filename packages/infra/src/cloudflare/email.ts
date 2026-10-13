/**
 * The `send_email` descriptor for api and alerting. Bind on prd only (`bindEmailSender`): other
 * stages run the same crons against live data and would email real users twice.
 */
import * as Cloudflare from "alchemy/Cloudflare"

export const NotificationsEmail = Cloudflare.Email.SendEmail("email", {
	allowedSenderAddresses: ["notifications@noreply.maple.dev"],
})
