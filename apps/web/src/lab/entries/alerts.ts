import { Effect, Schema } from "effect"
import * as Shell from "../../shell"
import { AlertsLabFlags, alertsLabFlags, init, update } from "../alerts-lab/update"
import { Message, Model } from "../alerts-lab/model"
import { view } from "../alerts-lab/view-page"
import { LabShellFlags, labShellFlags, labShellSubscriptions } from "../app-shell"
import { defineLabWithFlags } from "../define"

/**
 * `/lab/alerts`: the `/alerts` Inbox, Rules and Routing tabs and the incident page over one
 * fixture org, inside the real shell.
 */
const toShell = (message: Shell.Message) => Message.GotShellMessage({ message })

const subscriptions = labShellSubscriptions<Model, Message>(toShell)

export const lab = defineLabWithFlags("Alerts", {
	Model,
	Flags: Schema.Struct({ ...AlertsLabFlags.fields, ...LabShellFlags.fields }),
	flags: Effect.map(Effect.all([alertsLabFlags, labShellFlags]), ([alerts, shell]) => ({ ...alerts, ...shell })),
	init,
	update,
	view,
	subscriptions,
})
