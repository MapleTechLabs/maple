import { definePage } from "../../contract"
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
			{ label: "Billing", href: billingHref() },
			{ label: "AI credits" },
		],
	},
)
