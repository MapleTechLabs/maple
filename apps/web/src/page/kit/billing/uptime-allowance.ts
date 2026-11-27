import { UPTIME_MONITOR_OVERAGE_LABEL, UPTIME_MONITORS_FEATURE_ID } from "@maple/domain/billing"
import type { BillingCustomer } from "@maple/domain/http"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { linkButton } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"

const BILLING_HREF = hrefOf(AppRoute.Settings({ search: { tab: "billing" } }))

/** The org's uptime monitor balance: how many the plan includes, how many it has, and what past them costs. */
export const MonitorAllowance = Schema.Struct({
	included: Schema.Number,
	used: Schema.Number,
	/** A paid plan bills each monitor past `included`; without it (the trial) the next one is refused. */
	isBilledPastIncluded: Schema.Boolean,
})
export type MonitorAllowance = typeof MonitorAllowance.Type

/** The customer's monitor balance; null when the plan has no monitor meter or no cap at all. */
export const monitorAllowanceOf = (customer: BillingCustomer): MonitorAllowance | null => {
	const balance = customer.balances?.[UPTIME_MONITORS_FEATURE_ID]
	if (balance === undefined || balance.unlimited === true) return null
	return {
		included: balance.granted ?? 0,
		used: balance.usage ?? 0,
		isBilledPastIncluded: balance.overageAllowed === true,
	}
}

export type MonitorCostNotice = Readonly<{
	tone: "info" | "warn"
	title: string
	body: string
	/** Links to Billing: the trial has to add a card before it can go past the included monitors. */
	needsCard: boolean
}>

/** What creating one more monitor costs, said before the click; null while it is still free. */
export const monitorCostNotice = (allowance: MonitorAllowance | null): MonitorCostNotice | null => {
	if (allowance === null || allowance.included === 0) return null
	const { included, used } = allowance
	const price = `${UPTIME_MONITOR_OVERAGE_LABEL} a month`
	if (!allowance.isBilledPastIncluded)
		return used < included
			? null
			: {
					tone: "warn",
					title: `You've used all ${included} included monitors`,
					body: `Add a card to create more. Each monitor past ${included} costs ${price}.`,
					needsCard: true,
				}
	if (used >= included)
		return {
			tone: "info",
			title: `This monitor adds ${price} to your bill`,
			body: `Your plan includes ${included} monitors and this organization has ${used}. Each one past ${included} costs ${price}.`,
			needsCard: false,
		}
	if (used === included - 1)
		return {
			tone: "info",
			title: "This is your last included monitor",
			body: `Your plan includes ${included} monitors. Each one after it costs ${price}.`,
			needsCard: false,
		}
	return null
}

/** The callout above a create button that says what the next uptime monitor costs. */
export const monitorCostCallout = <M>(
	h: HtmlBuilder<M>,
	notice: MonitorCostNotice,
	options: Readonly<{ className?: string }> = {},
): Html =>
	alert(
		h,
		{
			variant: notice.tone,
			size: "sm",
			role: "status",
			...(options.className === undefined ? undefined : { className: options.className }),
		},
		[
			icon(h, "CreditCardIcon"),
			alertTitle(h, [notice.title], "text-foreground"),
			alertDescription(h, [notice.body]),
			...(notice.needsCard
				? [alertAction(h, [linkButton(h, { size: "sm", href: BILLING_HREF }, ["Add card"])])]
				: []),
		],
	)
