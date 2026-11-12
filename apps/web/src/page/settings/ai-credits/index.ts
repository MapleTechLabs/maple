import { definePage } from "../../contract"
import { settingsTabLabels } from "../nav"
import { billingHref } from "./hrefs"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** `/settings/billing/ai-credits`: this cycle's AI credits by surface, model and code review. */
export const page = definePage(
	"BillingAiCredits",
	{ Model, Message },
	{
		routes: ["BillingAiCredits"],
		init,
		update,
		view,
		breadcrumbs: () => [
			{ label: "Settings", href: "/settings" },
			{ label: settingsTabLabels.billing, href: billingHref() },
			{ label: "AI credits" },
		],
	},
)
