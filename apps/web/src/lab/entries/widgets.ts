import { Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import * as Shell from "../../shell"
import { liveQueryStream } from "../../data/live-query"
import { dashboardsOf } from "../../page/dashboards/kit/store"
import type { Resources } from "../../platform/resources"
import { ViewerFlags, viewerFlags } from "../../ui/logs/viewer"
import { LabShellFlags, labShellFlags } from "../app-shell"
import { defineLabWithFlags } from "../define"
import { Message, Model } from "../widget-lab/model"
import { init, update } from "../widget-lab/update"
import { view } from "../widget-lab/view"

/** `/lab/widgets`: every dashboard widget renderer over its bundled sample data, in the app shell. */
const toShell = (message: Shell.Message) => Message.GotShellMessage({ message })

const subscriptions = Subscription.make<Model, Message, Resources>()((entry) => ({
	shellViewport: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () => Stream.map(Shell.viewportChanges, toShell),
		},
	),
	shellSidebarShortcut: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () => Stream.map(Shell.sidebarShortcut, toShell),
		},
	),
	// The org's dashboards sync starts with the widgets; the rows are not read here.
	dashboards: entry(
		{ orgId: Schema.NullOr(Schema.String) },
		{
			modelToDependencies: (model) => ({ orgId: model.orgId }),
			dependenciesToStream: ({ orgId }) =>
				orgId === null
					? Stream.empty
					: Stream.unwrap(
							Effect.map(dashboardsOf(orgId), (collection) =>
								liveQueryStream(
									(q) => q.from({ d: collection }),
									() => Message.UpdatedDashboards({ orgId }),
								),
							),
						),
		},
	),
}))

export const lab = defineLabWithFlags("Widgets", {
	Model,
	Flags: Schema.Struct({ ...ViewerFlags.fields, ...LabShellFlags.fields }),
	flags: Effect.map(Effect.all([viewerFlags, labShellFlags]), ([viewer, shell]) => ({
		...viewer,
		...shell,
	})),
	init,
	update,
	view,
	subscriptions,
})
