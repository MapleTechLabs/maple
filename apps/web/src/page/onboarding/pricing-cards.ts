import { AttachRequest, CatalogPlansResponse } from "@maple/domain/http"
import {
	buildCheckoutSuccessUrl,
	CHECKOUT_CONFIRM_POLL_MS,
	CHECKOUT_CONFIRM_TIMEOUT_MS,
} from "../../lib/billing/checkout-return"
import { displayError } from "@maple/web-data/lib/error-messages"
import { Duration, Effect, Schema } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { load } from "foldkit/navigation"
import { MapleApiClient, MapleInternalApiClient } from "../../platform/api-clients"
import type { Resources } from "../../platform/resources"
import { trackProduct } from "../../data/analytics"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { getScenario } from "./pricing-plans"

// `PricingCards` for a planless org: the catalog (`billingPlansAtom`), and a plan's trial or subscribe
// button, which attaches it and follows Autumn's checkout link to Stripe.

export const PlansData = AsyncData.Schema(CatalogPlansResponse, LoadFailure)

export const CheckoutReturn = Schema.Literals(["Idle", "Confirming", "TimedOut"])
export type CheckoutReturn = typeof CheckoutReturn.Type

export const Model = Schema.Struct({
	plans: PlansData.schema,
	/** The plan whose button spins; kept while the page leaves for Stripe. */
	loadingPlanId: Schema.NullOr(Schema.String),
	/** `useCheckoutReturn`: back from Stripe (`?checkout=complete`), waiting on the Autumn sync. */
	checkoutReturn: CheckoutReturn,
})
export type Model = typeof Model.Type

export const init = (): Model => ({ plans: PlansData.Loading(), loadingPlanId: null, checkoutReturn: "Idle" })

export const Message = defineMessageUnion({
	SucceededLoadPlans: { response: CatalogPlansResponse },
	FailedLoadPlans: { failure: LoadFailure },
	ClickedPlan: { planId: Schema.String },
	SucceededAttach: { paymentUrl: Schema.NullOr(Schema.String) },
	FailedAttach: { message: Schema.String },
	ClickedEnterpriseContact: {},
	CompletedOpenEnterpriseContact: {},
	CompletedOpenCheckout: {},
	CompletedTrackCheckoutStarted: {},
	/** `trackProduct("plan_checkout_returned")` was handed to the session SDK. */
	CompletedTrackCheckoutReturned: {},
	ElapsedCheckoutPoll: {},
	ElapsedCheckoutTimeout: {},
})
export type Message = typeof Message.Type

/** What the page does with the outcome: refresh the customer, or toast. */
export const OutMessage = defineMessageUnion({
	/** Leaving for Stripe: the customer is re-read, but nothing is toasted. */
	ChangedPlan: { isLeavingForCheckout: Schema.Boolean },
	FailedChangePlan: { message: Schema.String },
	/** Waiting on the Stripe to Autumn sync: read the customer again. */
	RequestedCustomerRefresh: {},
	/** The wait gave up: drop `checkout=complete` from the URL (replace). */
	RequestedClearCheckoutMarker: {},
})
export type OutMessage = typeof OutMessage.Type

export const LoadPlans = Command.define("LoadPlans", {
	messages: [Message.SucceededLoadPlans, Message.FailedLoadPlans],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiClient
		const response = yield* client.billingPublic.listPlans()
		return Message.SucceededLoadPlans({ response })
	}).pipe(
		Effect.catch((error) => Effect.succeed(Message.FailedLoadPlans({ failure: toLoadFailure(error) }))),
	),
})

/** `attach({ planId, successUrl })`: Stripe returns to this page with the checkout marker. */
export const AttachPlan = Command.define("AttachPlan", {
	args: { planId: Schema.String },
	messages: [Message.SucceededAttach, Message.FailedAttach],
	execute: ({ planId }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const successUrl = yield* Effect.sync(() => buildCheckoutSuccessUrl(window.location.href))
			const result = yield* client.billing.attach({
				payload: new AttachRequest({ planId, successUrl }),
			})
			return Message.SucceededAttach({ paymentUrl: result.paymentUrl ?? null })
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(Message.FailedAttach({ message: displayError(error).message })),
			),
		),
})

export const OpenCheckout = Command.define("OpenCheckout", {
	args: { url: Schema.String },
	messages: [Message.CompletedOpenCheckout],
	execute: ({ url }) => load(url).pipe(Effect.as(Message.CompletedOpenCheckout())),
})

/** `useCheckoutReturn`: the wait on the Autumn sync ended; `confirmed` says whether the plan showed. */
export const TrackCheckoutReturned = Command.define("TrackCheckoutReturned", {
	args: { confirmed: Schema.Boolean },
	messages: [Message.CompletedTrackCheckoutReturned],
	execute: ({ confirmed }) =>
		trackProduct("plan_checkout_returned", { confirmed }).pipe(
			Effect.as(Message.CompletedTrackCheckoutReturned()),
		),
})

/** `useBillingActions().attach`: checkout intent, recorded before the tab leaves for Stripe. */
export const TrackCheckoutStarted = Command.define("TrackCheckoutStarted", {
	args: { planId: Schema.String },
	messages: [Message.CompletedTrackCheckoutStarted],
	execute: ({ planId }) =>
		trackProduct("plan_checkout_started", { plan_id: planId }).pipe(
			Effect.as(Message.CompletedTrackCheckoutStarted()),
		),
})

const ENTERPRISE_CONTACT_URL = "https://cal.com/david-granzin/30min?overlayCalendar=true"

export const OpenEnterpriseContact = Command.define("OpenEnterpriseContact", {
	messages: [Message.CompletedOpenEnterpriseContact],
	execute: Effect.sync(() => {
		window.open(ENTERPRISE_CONTACT_URL, "_blank", "noopener,noreferrer")
		return Message.CompletedOpenEnterpriseContact()
	}),
})

/** `CHECKOUT_CONFIRM_POLL_MS`: the customer is re-read this often while confirming. */
export const WaitCheckoutPoll = Command.define("WaitCheckoutPoll", {
	messages: [Message.ElapsedCheckoutPoll],
	execute: Effect.sleep(Duration.millis(CHECKOUT_CONFIRM_POLL_MS)).pipe(
		Effect.as(Message.ElapsedCheckoutPoll()),
	),
})

/** `CHECKOUT_CONFIRM_TIMEOUT_MS`: then the offer comes back, with the timed-out note. */
export const WaitCheckoutTimeout = Command.define("WaitCheckoutTimeout", {
	messages: [Message.ElapsedCheckoutTimeout],
	execute: Effect.sleep(Duration.millis(CHECKOUT_CONFIRM_TIMEOUT_MS)).pipe(
		Effect.as(Message.ElapsedCheckoutTimeout()),
	),
})

/**
 * A return from Stripe while the customer is still planless waits on the sync. Once the plan
 * shows up, the root's plan gate takes the page away (the plan picker and the wizard both leave).
 */
export const initReturning = (
	isReturning: boolean,
): { readonly model: Model; readonly commands: ReadonlyArray<Command.Command<Message, never, Resources>> } =>
	isReturning
		? {
				model: { ...init(), checkoutReturn: "Confirming" },
				commands: [LoadPlans(), WaitCheckoutPoll(), WaitCheckoutTimeout()],
			}
		: { model: init(), commands: [LoadPlans()] }

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		SucceededLoadPlans: ({ response }) => ({
			model: { ...model, plans: PlansData.Success({ data: response }) },
		}),
		FailedLoadPlans: ({ failure }) => ({
			model: { ...model, plans: PlansData.Failure({ error: failure }) },
		}),
		// TODO(plan-change): an upgrade or downgrade previews the change in a ConfirmDialog first;
		// only a planless org reaches these screens, where every plan is a new subscription.
		ClickedPlan: ({ planId }) => {
			const plan = AsyncData.getOrElse(model.plans, () => ({ plans: [] })).plans.find(
				(found) => found.id === planId,
			)
			const isChange =
				plan !== undefined && (getScenario(plan) === "upgrade" || getScenario(plan) === "downgrade")
			return model.loadingPlanId !== null || isChange
				? { model }
				: { model: { ...model, loadingPlanId: planId }, commands: [AttachPlan({ planId })] }
		},
		// The button keeps spinning while the page leaves for Stripe: a second click would 409.
		// The mutation's reactivity keys re-read the catalog and the customer either way.
		SucceededAttach: ({ paymentUrl }) =>
			paymentUrl === null
				? {
						model: { ...model, loadingPlanId: null },
						commands: [LoadPlans()],
						outMessage: OutMessage.ChangedPlan({ isLeavingForCheckout: false }),
					}
				: {
						model,
						commands: [
							LoadPlans(),
							...(model.loadingPlanId === null
								? []
								: [TrackCheckoutStarted({ planId: model.loadingPlanId })]),
							OpenCheckout({ url: paymentUrl }),
						],
						outMessage: OutMessage.ChangedPlan({ isLeavingForCheckout: true }),
					},
		FailedAttach: ({ message: failure }) => ({
			model: { ...model, loadingPlanId: null },
			outMessage: OutMessage.FailedChangePlan({ message: failure }),
		}),
		ClickedEnterpriseContact: () => ({ model, commands: [OpenEnterpriseContact()] }),
		CompletedOpenEnterpriseContact: () => ({ model }),
		CompletedOpenCheckout: () => ({ model }),
		CompletedTrackCheckoutStarted: () => ({ model }),
		CompletedTrackCheckoutReturned: () => ({ model }),
		ElapsedCheckoutPoll: () =>
			model.checkoutReturn === "Confirming"
				? { model, commands: [WaitCheckoutPoll()], outMessage: OutMessage.RequestedCustomerRefresh() }
				: { model },
		ElapsedCheckoutTimeout: () =>
			model.checkoutReturn === "Confirming"
				? {
						model: { ...model, checkoutReturn: "TimedOut" },
						commands: [TrackCheckoutReturned({ confirmed: false })],
						outMessage: OutMessage.RequestedClearCheckoutMarker(),
					}
				: { model },
	})
