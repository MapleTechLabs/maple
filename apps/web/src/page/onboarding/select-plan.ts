import type { BillingCustomer } from "@maple/domain/http"
import { hasLapsedPlan } from "../../lib/billing/plan-gating"
import { TRIAL_DURATION_DAYS } from "../../lib/billing/plans"
import { Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { Resources } from "../../platform/resources"
import { badge } from "../../ui/display"
import { heading } from "../../ui/heading"
import { icon } from "../../ui/icon"
import * as PricingCards from "./pricing-cards"
import * as PricingCardsView from "./pricing-cards-view"

// `/select-plan`: the trial pitch, or for a returning subscriber whose plan lapsed, the reactivation framing,
// over the same pricing cards.

export const Model = Schema.TaggedStruct("SelectPlan", { pricing: PricingCards.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotPricingMessage: { message: PricingCards.Message } })
export type Message = typeof Message.Type

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PricingCards.OutMessage, Resources>

const toPricing = (message: PricingCards.Message) => Message.GotPricingMessage({ message })

/** `isCheckoutReturn`: back from Stripe (`?checkout=complete`), the cards wait on the sync. */
export const init = (isCheckoutReturn: boolean): UpdateReturn => {
	const pricing = PricingCards.initReturning(isCheckoutReturn)
	return {
		model: { _tag: "SelectPlan", pricing: pricing.model },
		commands: Command.mapMessages(pricing.commands, toPricing),
	}
}

export const update = (model: Model, message: Message): UpdateReturn => {
	const next = PricingCards.update(model.pricing, message.message)
	return {
		model: { ...model, pricing: next.model },
		commands: Command.mapMessages(next.commands ?? [], toPricing),
		outMessage: next.outMessage,
	}
}

type H = HtmlBuilder<Message>

const planHeading = (h: H, isReactivating: boolean): Html =>
	h.div(
		[h.Class("text-center flex flex-col items-center")],
		[
			...(isReactivating
				? []
				: [
						badge(
							h,
							{
								pill: true,
								size: "lg",
								className:
									"mb-6 gap-2 border-primary-a3 bg-primary-a1 px-3 text-2xs tracking-wider text-primary uppercase sm:text-2xs",
							},
							[
								icon(h, "RocketIcon", { size: 14, className: "size-3.5" }),
								String(TRIAL_DURATION_DAYS),
								"-day free trial",
							],
						),
					]),
			heading(
				h,
				{ level: 1, variant: "display", className: "text-balance" },
				[isReactivating ? "Pick up where you left off" : "Start your free trial"],
			),
			h.p(
				[
					h.Class(
						"font-display text-muted-foreground mt-4 text-sm md:text-base leading-relaxed max-w-lg mx-auto [text-wrap:balance]",
					),
				],
				[
					isReactivating
						? "Your data is still here. Choose a plan to start ingesting again. Cancel anytime."
						: `Try Maple free for ${TRIAL_DURATION_DAYS} days. You won't be charged until the trial ends. Cancel anytime.`,
				],
			),
		],
	)

export const view = (h: H, model: Model, customer: BillingCustomer | undefined): Html =>
	h.main(
		[
			h.Class(
				"relative min-h-screen overflow-hidden bg-background flex flex-col items-center justify-center py-12",
			),
		],
		[
			h.div(
				[
					h.Class(
						"pointer-events-none absolute inset-0 flex items-center justify-center [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black)]",
					),
				],
				[
					h.div(
						[
							h.Class(
								"absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]",
							),
						],
						[],
					),
				],
			),
			h.div(
				[h.Class("pointer-events-none absolute inset-0")],
				[
					h.div(
						[
							h.Class(
								"absolute top-[20%] left-[50%] -translate-x-1/2 -translate-y-1/2 size-[40rem] rounded-full bg-primary-a1 blur-[100px]",
							),
						],
						[],
					),
				],
			),
			h.section(
				[h.Class("relative mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 md:px-8 z-10")],
				[
					planHeading(h, hasLapsedPlan(customer)),
					h.div(
						[h.Class("mt-4")],
						[
							h.submodel({
								slotId: "pricing-cards",
								model: model.pricing,
								view: PricingCardsView.view,
								toParentMessage: toPricing,
							}),
						],
					),
				],
			),
		],
	)
