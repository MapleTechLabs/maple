import { Schema } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { destinationRows, incidentRows, ruleRows, ruleStateRows } from "../shared/collections"
import { Message } from "./message"
import { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { breadcrumbsOf, view } from "./view"

const byOrg = { orgId: Schema.String }

const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	rules: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) => ruleRows(orgId, (rows) => Message.UpdatedRules({ orgId, rows })),
	}),
	incidents: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) => incidentRows(orgId, (rows) => Message.UpdatedIncidents({ orgId, rows })),
	}),
	states: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) => ruleStateRows(orgId, (rows) => Message.UpdatedRuleStates({ orgId, rows })),
	}),
	destinations: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) =>
			destinationRows(orgId, (rows) => Message.UpdatedDestinations({ orgId, rows })),
	}),
}))

/** `/alerts/$ruleId`: one instance per rule; the tab and window are search. */
export const page = definePage(
	"AlertRule",
	{ Model, Message },
	{
		routes: ["AlertRule"],
		key: (route) => route.ruleId,
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
