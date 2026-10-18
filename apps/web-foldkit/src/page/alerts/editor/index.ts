import { Schema } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { destinationRows, incidentRows, ruleRows, ruleStateRows } from "../shared/collections"
import { init } from "./init"
import { Message } from "./message"
import { Model } from "./model"
import { update } from "./update"
import { breadcrumbsOf, view } from "./view"

const byOrg = { orgId: Schema.String }

/** `useAlertRulesList`, `useAlertIncidentsList` and `useAlertDestinationsList`. */
const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	rules: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) => ruleRows(orgId, (rows) => Message.UpdatedRules({ orgId, rows })),
	}),
	states: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) => ruleStateRows(orgId, (rows) => Message.UpdatedRuleStates({ orgId, rows })),
	}),
	incidents: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) => incidentRows(orgId, (rows) => Message.UpdatedIncidents({ orgId, rows })),
	}),
	destinations: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) =>
			destinationRows(orgId, (rows) => Message.UpdatedDestinations({ orgId, rows })),
	}),
}))

/** `/alerts/create`: a new rule, a template, a chart's prefill, or `?ruleId=` to edit one. */
export const page = definePage(
	"AlertEditor",
	{ Model, Message },
	{
		routes: ["AlertsCreate"],
		// A different rule or prefill source is a different draft (`RuleDraft.key` remounts the surface).
		key: (route) => JSON.stringify(route.search),
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
