import { Schema } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { destinationRows } from "../../kit/alert-collections"
import { Message, Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

// The org's alert destinations, live: the same rows the alert rule, SLO and uptime editors pick from.
const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	destinations: entry(
		{ orgId: Schema.String },
		{
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				destinationRows(orgId, (rows) => Message.UpdatedDestinations({ orgId, rows })),
		},
	),
}))

/** `/cost/budgets/new`: one instance per budget being edited, or the new one. */
export const page = definePage(
	"CostBudgetNew",
	{ Model, Message },
	{
		routes: ["CostBudgetNew"],
		key: (route) => route.search.budgetId ?? "new",
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: (model) => [
			{ label: "Cloud cost", href: "/cost" },
			{ label: "Budgets", href: "/cost/budgets" },
			{
				label: model.search.budgetId === undefined ? "New budget" : "Edit budget",
				isPageHeading: true,
			},
		],
	},
)
