import { Clock, Duration, Effect, Option, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { pollTicks } from "../../../data/poll"
import type { Resources } from "../../../platform/resources"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { incidentRows, ruleRows, ruleStateRows } from "../shared/collections"
import { incidentViewOf } from "./derive"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { breadcrumbsOf, view } from "./view"

const byOrg = { orgId: Schema.String }

const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	incidents: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) =>
			incidentRows(orgId, (rows) => Message.UpdatedIncidents({ orgId, rows })),
	}),
	rules: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) => ruleRows(orgId, (rows) => Message.UpdatedRules({ orgId, rows })),
	}),
	states: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) =>
			ruleStateRows(orgId, (rows) => Message.UpdatedRuleStates({ orgId, rows })),
	}),
	clock: entry(
		{ isOpen: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({
				isOpen: Option.exists(incidentViewOf(model), ({ incident }) => incident.status === "open"),
			}),
			dependenciesToStream: ({ isOpen }) =>
				isOpen
					? pollTicks(Duration.minutes(1)).pipe(
							Stream.mapEffect(() =>
								Effect.map(Clock.currentTimeMillis, (nowMs) =>
									Message.TickedClock({ nowMs }),
								),
							),
						)
					: Stream.empty,
		},
	),
}))

/** `/alerts/incidents/$incidentId`: one instance per incident. */
export const page = definePage(
	"AlertIncident",
	{ Model, Message },
	{
		routes: ["AlertIncident"],
		key: (route) => route.incidentId,
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
