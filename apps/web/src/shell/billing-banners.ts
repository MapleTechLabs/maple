import { type BillingCustomer, CustomerPortalRequest } from "@maple/domain/http"
import {
	getActivePlan,
	getLapsedPlan,
	getPastDueSubscription,
	getQuotaStatus,
} from "../lib/billing/plan-gating"
import { Effect, Option } from "effect"
import { ShellDefinition } from "./definition"
import type { Html } from "foldkit/html"
import type { ShellViewBuilder } from "./composition"
import { load } from "foldkit/navigation"
import { MapleInternalApiClient } from "../platform/api-clients"
import { AppRoute, hrefOf } from "../route"
import { alert, alertAction, alertDescription, alertTitle } from "../ui/alert"
import { button, linkButton } from "../ui/button"
import { iconButton } from "../ui/icon-button"
import { icon } from "../ui/icon"
import { Message } from "./message"

// The Clerk-mode billing banners above the page body:
// subscription ended, payment failed and the usage quota, all read from the Autumn customer.

/** `useSessionDismiss("quota-banner-approaching")`. */
export const QUOTA_DISMISS_KEY = "quota-banner-approaching"

export const readQuotaApproachingDismissed: Effect.Effect<boolean> = Effect.sync(
	() => window.sessionStorage.getItem(QUOTA_DISMISS_KEY) === "1",
).pipe(Effect.orElseSucceed(() => false))

export const DismissQuotaBanner = ShellDefinition.makeCommand("DismissQuotaBanner", {
	messages: [Message.CompletedDismissQuotaBanner],
	handler: function* () {
		return () =>
			Effect.sync(() => window.sessionStorage.setItem(QUOTA_DISMISS_KEY, "1")).pipe(
				Effect.ignore,
				Effect.as(Message.CompletedDismissQuotaBanner()),
			)
	},
})

/** `openCustomerPortal({ returnUrl: location.href })`: Autumn's portal URL, then there. */
export const OpenCustomerPortal = ShellDefinition.makeCommand("OpenCustomerPortal", {
	messages: [Message.CompletedOpenCustomerPortal, Message.FailedOpenCustomerPortal],
	handler: function* () {
		return () =>
			Effect.gen(function* () {
				const client = yield* MapleInternalApiClient
				const returnUrl = yield* Effect.sync(() => window.location.href)
				const portal = yield* client.billing.openCustomerPortal({
					payload: new CustomerPortalRequest({ returnUrl }),
				})
				yield* load(portal.url)
				return Message.CompletedOpenCustomerPortal()
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed(
						Message.FailedOpenCustomerPortal({
							message:
								"message" in error &&
								typeof error.message === "string" &&
								error.message !== ""
									? error.message
									: "Couldn't open the billing portal.",
						}),
					),
				),
			)
	},
})

type H = ShellViewBuilder

const banner = (h: H, variant: "crit" | "warn", children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("px-4 pt-3")],
		[alert(h, { variant }, [icon(h, "CircleWarningIcon", { size: 16 }), ...children])],
	)

/** `SubscriptionEndedBanner`: the org held a plan and it lapsed. */
const subscriptionEnded = (h: H, customer: BillingCustomer): ReadonlyArray<Html> => {
	const lapsed = getLapsedPlan(customer)
	if (lapsed === null) return []
	const planName = lapsed.plan?.name ?? lapsed.planId
	return [
		banner(h, "crit", [
			alertTitle(h, ["Subscription ended"]),
			alertDescription(h, [
				planName ? `Your ${planName} plan has ended.` : "Your plan has ended.",
				" Your existing data is still here, but new telemetry is being rejected until you pick a plan.",
			]),
			alertAction(h, [
				linkButton(h, { size: "sm", href: hrefOf(AppRoute.SelectPlan({ search: {} })) }, [
					"Choose a plan",
				]),
			]),
		]),
	]
}

/** `PaymentFailedBanner`: overdue payments, until the payment method is updated. */
const paymentFailed = (h: H, customer: BillingCustomer): ReadonlyArray<Html> =>
	getPastDueSubscription(customer) === null
		? []
		: [
				banner(h, "crit", [
					alertTitle(h, ["Payment failed"]),
					alertDescription(h, [
						"We couldn't process your most recent payment. Update your payment method to keep your data flowing.",
					]),
					alertAction(h, [
						button(
							h,
							{ size: "sm", attributes: [h.OnClick(Message.ClickedUpdatePaymentMethod())] },
							["Update payment method"],
						),
					]),
				]),
			]

/** `QuotaBanner`: a base plan nearing (dismissible) or past its included usage. */
const quota = (h: H, customer: BillingCustomer, isApproachingDismissed: boolean): ReadonlyArray<Html> => {
	const status = getQuotaStatus(customer)
	if (status === "ok" || (status === "approaching" && isApproachingDismissed)) return []
	const planName = getActivePlan(customer)?.plan?.name ?? "plan"
	const isOver = status === "over"
	return [
		banner(h, isOver ? "crit" : "warn", [
			alertTitle(h, [
				isOver
					? `You've reached your ${planName} usage limit`
					: `You're nearing your ${planName} usage limit`,
			]),
			alertDescription(h, [
				isOver
					? "You've used all the logs, traces, or metrics included in your plan this period. Upgrade for more headroom."
					: "You're approaching the usage included in your plan. Upgrade for more headroom before you reach the limit.",
			]),
			alertAction(
				h,
				[
					linkButton(
						h,
						{
							size: "sm",
							variant: isOver ? "default" : "outline",
							href: hrefOf(AppRoute.Settings({ search: { tab: "billing" } })),
						},
						[isOver ? "Upgrade plan" : "View usage"],
					),
					...(isOver
						? []
						: [
								iconButton(
									h,
									{
										label: "Dismiss",
										attributes: [h.OnClick(Message.ClickedDismissQuotaBanner())],
									},
									[icon(h, "XmarkIcon")],
								),
							]),
				],
				"flex items-center gap-2",
			),
		]),
	]
}

/** The three banners in order; nothing before the customer is known. */
export const billingBanners = (
	h: H,
	maybeCustomer: Option.Option<BillingCustomer>,
	isQuotaApproachingDismissed: boolean,
): ReadonlyArray<Html> =>
	Option.match(maybeCustomer, {
		onNone: () => [],
		onSome: (customer) => [
			...subscriptionEnded(h, customer),
			...paymentFailed(h, customer),
			...quota(h, customer, isQuotaApproachingDismissed),
		],
	})
