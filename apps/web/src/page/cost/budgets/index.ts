import { definePage } from "../../contract"
import { Message, Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** `/cost/budgets`: the org's cost budgets and where each stands in its current period. */
export const page = definePage(
	"CostBudgets",
	{ Model, Message },
	{
		routes: ["CostBudgets"],
		key: () => "cost-budgets",
		init,
		update,
		view,
		breadcrumbs: () => [
			{ label: "Cost", href: "/cost" },
			{ label: "Budgets", isPageHeading: true },
		],
	},
)
