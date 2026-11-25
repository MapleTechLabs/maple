import { type BillingCustomer, CustomerPortalRequest } from "@maple/domain/http"
import {
	getActivePlan,
	getLapsedPlan,
	getNoCardTrial,
	getPastDueSubscription,
	getQuotaStatus,
	getTrialNotice,
	hasEndedNoCardTrial,
	type TrialNotice,
} from "../page/kit/billing/plan-gating"
import { TRIAL_SIGNAL_GB } from "@maple/domain/billing"
import { formatDateInTimezone } from "@maple/ui/lib/timezone-format"
import { getBrowserTimeZone } from "@maple/ui/lib/timezone"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { load } from "foldkit/navigation"
import { MapleInternalApiClient } from "../platform/api-clients"
import { AppRoute, hrefOf } from "../route"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import { iconButton } from "@maple/views/ui/icon-button"
import { icon } from "@maple/views/ui/icon"
import { Message } from "./message"
import { hstackClass } from "@maple/views/ui/stack"

// The Clerk-mode billing banners above the page body: subscription or trial ended, payment failed,
// and the usage quota (or, on the no-card trial, its caps and last days), all read from the Autumn customer.

/** `useSessionDismiss("quota-banner-approaching")`. */
export const QUOTA_DISMISS_KEY = "quota-banner-approaching"

export const readQuotaApproachingDismissed: Effect.Effect<boolean> = Effect.sync(
	() => window.sessionStorage.getItem(QUOTA_DISMISS_KEY) === "1",
).pipe(Effect.orElseSucceed(() => false))

export const DismissQuotaBanner = Command.define("DismissQuotaBanner", {
	messages: [Message.CompletedDismissQuotaBanner],
	execute: Effect.sync(() => window.sessionStorage.setItem(QUOTA_DISMISS_KEY, "1")).pipe(
		Effect.ignore,
		Effect.as(Message.CompletedDismissQuotaBanner()),
	),
})

/** `openCustomerPortal({ returnUrl: location.href })`: Autumn's portal URL, then there. */
export const OpenCustomerPortal = Command.define("OpenCustomerPortal", {
	messages: [Message.CompletedOpenCustomerPortal, Message.FailedOpenCustomerPortal],
	execute: Effect.gen(function* () {
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
						"message" in error && typeof error.message === "string" && error.message !== ""
							? error.message
							: "Couldn't open the billing portal.",
				}),
			),
		),
	),
})

type H = HtmlBuilder<Message>

const banner = (h: H, variant: "crit" | "warn", children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("px-4 pt-3")],
		[alert(h, { variant }, [icon(h, "CircleWarningIcon", { size: 16 }), ...children])],
	)

const BILLING_HREF = hrefOf(AppRoute.Settings({ search: { tab: "billing" } }))

/** The org held a plan (or the no-card trial) and it lapsed. */
const subscriptionEnded = (h: H, customer: BillingCustomer): ReadonlyArray<Html> => {
	const lapsed = getLapsedPlan(customer)
	if (lapsed === null) return []
	const isTrial = hasEndedNoCardTrial(customer)
	const planName = lapsed.plan?.name ?? lapsed.planId
	return [
		banner(h, "crit", [
			alertTitle(h, [isTrial ? "Your free trial has ended" : "Subscription ended"]),
			alertDescription(h, [
				isTrial
					? "Your data is still here, but new telemetry is being rejected. Subscribe to keep ingesting."
					: `${planName ? `Your ${planName} plan has ended.` : "Your plan has ended."} Your existing data is still here, but new telemetry is being rejected until you pick a plan.`,
			]),
			alertAction(h, [
				linkButton(h, { size: "sm", href: hrefOf(AppRoute.SelectPlan({ search: {} })) }, [
					isTrial ? "Subscribe" : "Choose a plan",
				]),
			]),
		]),
	]
}

/** The capped signals (their feature ids are their names): "logs", "logs and traces", "logs, traces and metrics". */
const signalList = (featureIds: ReadonlyArray<string>): string =>
	Option.match(Arr.last(featureIds), {
		onNone: () => "",
		onSome: (last) =>
			featureIds.length === 1 ? last : `${Arr.join(Arr.dropRight(featureIds, 1), ", ")} and ${last}`,
	})

/** The no-card trial asking for a card: a signal at its cap, its last days, or a cap coming up. */
const trialBanner = (h: H, notice: TrialNotice, isApproachingDismissed: boolean): ReadonlyArray<Html> => {
	if (notice._tag === "Approaching" && isApproachingDismissed) return []
	const endsOn = formatDateInTimezone(notice.trial.endsAt, {
		timeZone: getBrowserTimeZone(),
		withYear: false,
	})
	const noCharge = ` You won't be charged before ${endsOn}.`
	const copy =
		notice._tag === "Capped"
			? {
					title: `${Str.capitalize(signalList(notice.featureIds))} ingest is paused`,
					body: `You've used the trial's ${TRIAL_SIGNAL_GB} GB of ${signalList(notice.featureIds)}. Add a card to resume and lift every cap.${noCharge}`,
				}
			: notice._tag === "Ending"
				? {
						title:
							notice.trial.daysRemaining <= 1
								? "Your free trial ends within a day"
								: `Your free trial ends in ${notice.trial.daysRemaining} days`,
						body: `Add a card to keep ingesting after ${endsOn}. Nothing is charged before then.`,
					}
				: {
						title: `You're nearing the trial's ${TRIAL_SIGNAL_GB} GB of ${signalList(notice.featureIds)}`,
						body: `Ingest for a signal pauses at its cap. Add a card to lift the caps.${noCharge}`,
					}
	const isApproaching = notice._tag === "Approaching"
	return [
		banner(h, notice._tag === "Capped" ? "crit" : "warn", [
			alertTitle(h, [copy.title]),
			alertDescription(h, [copy.body]),
			alertAction(
				h,
				[
					linkButton(h, { size: "sm", href: BILLING_HREF }, ["Add card"]),
					...(isApproaching
						? [
								iconButton(
									h,
									{
										label: "Dismiss",
										attributes: [h.OnClick(Message.ClickedDismissQuotaBanner())],
									},
									[icon(h, "XmarkIcon")],
								),
							]
						: []),
				],
				hstackClass({ gap: "2" }),
			),
		]),
	]
}

/** Overdue payments, until the payment method is updated. */
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

/** A base plan nearing (dismissible) or past its included usage. */
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
							href: BILLING_HREF,
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
				hstackClass({ gap: "2" }),
			),
		]),
	]
}

/** The banners in order; nothing before the customer is known. The trial's caps replace the quota's. */
export const billingBanners = (
	h: H,
	maybeCustomer: Option.Option<BillingCustomer>,
	isQuotaApproachingDismissed: boolean,
	nowMs: number,
): ReadonlyArray<Html> =>
	Option.match(maybeCustomer, {
		onNone: () => [],
		onSome: (customer) => {
			const notice = getTrialNotice(customer, nowMs)
			return [
				...subscriptionEnded(h, customer),
				...paymentFailed(h, customer),
				...(getNoCardTrial(customer, nowMs) !== null
					? notice === null
						? []
						: trialBanner(h, notice, isQuotaApproachingDismissed)
					: quota(h, customer, isQuotaApproachingDismissed)),
			]
		},
	})
