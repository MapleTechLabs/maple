import { AppRoute, hrefOf } from "../../../route"

/** `/settings/billing/ai-credits`: where this cycle's AI credits went. */
export const aiCreditsHref = (): string => hrefOf(AppRoute.BillingAiCredits())

/** The Billing tab the page belongs to. */
export const billingHref = (): string => hrefOf(AppRoute.Settings({ search: { tab: "billing" } }))
