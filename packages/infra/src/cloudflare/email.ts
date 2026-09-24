/**
 * The `EMAIL` Send Email binding, shared by the api and alerting Workers.
 * Production only: every other stage runs the same email crons against live
 * org data, so a binding there would send real users a second copy.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import type { MapleStage } from "./stage.ts"

export const NotificationsEmail = Cloudflare.Email.SendEmail("email", {
	allowedSenderAddresses: ["notifications@noreply.maple.dev"],
})

/** `{ EMAIL }` on prd, nothing elsewhere — spread into a Worker's bindings. */
export const emailBinding = (stage: MapleStage) =>
	stage.kind === "prd" ? { EMAIL: NotificationsEmail } : undefined
