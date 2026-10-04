/**
 * The `send_email` descriptor shared by the api and alerting Workers. Bound from
 * their inits on prd only (`bindEmailSender` in `@maple/backend/platform/email-sender`):
 * every other stage runs the same email crons against live org data, so a binding
 * there would send real users a second copy.
 */
import * as Cloudflare from "alchemy/Cloudflare"

export const NotificationsEmail = Cloudflare.Email.SendEmail("email", {
	allowedSenderAddresses: ["notifications@noreply.maple.dev"],
})
