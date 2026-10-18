import { Effect, Option, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import * as Shell from "../../shell"
import { AlertsLabFlags, alertsLabFlags, init, update } from "../alerts-lab/update"
import { Message, Model } from "../alerts-lab/model"
import { view } from "../alerts-lab/view-page"
import { LabShellFlags, labShellFlags } from "../app-shell"
import { defineLabWithFlags } from "../define"
import type { Resources } from "../../platform/resources"

/**
 * `/lab/alerts`: the `/alerts` Inbox, Rules and Routing tabs and the incident page over one
 * fixture org, inside the real shell.
 */
const toShell = (message: Shell.Message) => Message.GotShellMessage({ message })

const subscriptions = Subscription.make<Model, Message, Resources>()((entry) => ({
	shellViewport: entry(
		{},
		{ modelToDependencies: () => ({}), dependenciesToStream: () => Stream.map(Shell.viewportChanges, toShell) },
	),
	shellSidebarShortcut: entry(
		{},
		{ modelToDependencies: () => ({}), dependenciesToStream: () => Stream.map(Shell.sidebarShortcut, toShell) },
	),
	/** The shell's Pinned group reads the org's `dashboards` collection, as in the app root. */
	shellDashboards: entry(
		{ orgId: Schema.NullOr(Schema.String) },
		{
			modelToDependencies: (model) => ({ orgId: Option.getOrNull(model.shell.maybeOrgId) }),
			dependenciesToStream: ({ orgId }) =>
				orgId === null
					? Stream.empty
					: Shell.pinnedDashboardRows(orgId, (dashboards) =>
							toShell(Shell.Message.SucceededLoadDashboards({ orgId, dashboards })),
						),
		},
	),
}))

export const lab = defineLabWithFlags("Alerts", {
	Model,
	Flags: Schema.Struct({ ...AlertsLabFlags.fields, ...LabShellFlags.fields }),
	flags: Effect.map(Effect.all([alertsLabFlags, labShellFlags]), ([alerts, shell]) => ({ ...alerts, ...shell })),
	init,
	update,
	view,
	subscriptions,
})
