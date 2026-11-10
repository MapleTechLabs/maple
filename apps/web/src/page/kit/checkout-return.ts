import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { trackProduct } from "../../data/analytics"
import { CHECKOUT_CONFIRM_POLL_MS, CHECKOUT_CONFIRM_TIMEOUT_MS } from "./billing/checkout-return"

// Back from Stripe (`?checkout=complete`), a page waits on the Autumn sync. It re-reads the customer
// every poll until the plan shows up, or gives up at the timeout.

export const Model = Schema.Literals(["Idle", "Confirming", "TimedOut"])
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ElapsedPoll: {},
	ElapsedTimeout: {},
	/** `trackProduct("plan_checkout_returned")` was handed to the session SDK. */
	CompletedTrackReturned: {},
})
export type Message = typeof Message.Type

/** `CHECKOUT_CONFIRM_POLL_MS`: the customer is re-read this often while confirming. */
const WaitPoll = Command.define("WaitCheckoutPoll", {
	messages: [Message.ElapsedPoll],
	execute: Effect.sleep(Duration.millis(CHECKOUT_CONFIRM_POLL_MS)).pipe(Effect.as(Message.ElapsedPoll())),
})

/** `CHECKOUT_CONFIRM_TIMEOUT_MS`: then the wait gives up with the timed-out notice. */
const WaitTimeout = Command.define("WaitCheckoutTimeout", {
	messages: [Message.ElapsedTimeout],
	execute: Effect.sleep(Duration.millis(CHECKOUT_CONFIRM_TIMEOUT_MS)).pipe(
		Effect.as(Message.ElapsedTimeout()),
	),
})

/** The wait ended; `confirmed` says whether the plan showed up. */
const TrackReturned = Command.define("TrackCheckoutReturned", {
	args: { confirmed: Schema.Boolean },
	messages: [Message.CompletedTrackReturned],
	execute: ({ confirmed }) =>
		trackProduct("plan_checkout_returned", { confirmed }).pipe(
			Effect.as(Message.CompletedTrackReturned()),
		),
})

/** What the page does next: re-read the customer (`Polled`), or drop the marker (`Confirmed`, `TimedOut`). */
export type Outcome = "Polled" | "Confirmed" | "TimedOut"

export type Step = Readonly<{
	model: Model
	commands: ReadonlyArray<Command.Command<Message>>
	outcome: Outcome | null
}>

const unchanged = (model: Model): Step => ({ model, commands: [], outcome: null })

/** `isReturning`: the page opened with `?checkout=complete`, so it waits on the sync. */
export const init = (isReturning: boolean): Step =>
	isReturning
		? { model: "Confirming", commands: [WaitPoll(), WaitTimeout()], outcome: null }
		: unchanged("Idle")

export const update = (model: Model, message: Message): Step =>
	Message.match<Step>(message, {
		ElapsedPoll: () =>
			model === "Confirming" ? { model, commands: [WaitPoll()], outcome: "Polled" } : unchanged(model),
		ElapsedTimeout: () =>
			model === "Confirming"
				? { model: "TimedOut", commands: [TrackReturned({ confirmed: false })], outcome: "TimedOut" }
				: unchanged(model),
		CompletedTrackReturned: () => unchanged(model),
	})

/** The customer now carries a plan: the wait is over. `null` while not waiting. */
export const confirmed = (model: Model): Step | null =>
	model === "Confirming"
		? { model: "Idle", commands: [TrackReturned({ confirmed: true })], outcome: "Confirmed" }
		: null
