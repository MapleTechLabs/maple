import { CatalogPlan, CatalogPlanItem, CatalogPlanItemPrice } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as PricingCardsView from "../../page/onboarding/pricing-cards-view"
import * as QuickStartTeamView from "../../page/onboarding/quick-start-team-view"
import * as QuickStartView from "../../page/onboarding/quick-start-view"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import { defineLabWithFlags } from "../define"
import { defineMessageUnion } from "foldkit/message"
import * as PricingCards from "../../page/onboarding/pricing-cards"
import * as QuickStart from "../../page/onboarding/quick-start"
import { DEFAULT_QUICK_START_STATE, STEP_IDS } from "../../page/onboarding/quick-start-state"
import { ready, TeamMessage, updateTeam } from "../../page/onboarding/quick-start-team"

// `/lab/onboarding`: the real quick-start screen with a sample catalog; checkout, rename and invites are
// simulated and nothing is saved. `?step=stack` opens a later step, Restart starts over.

const meteredItem = (
	featureId: string,
	included: number,
	amount: number,
	billingUnits: number,
	secondaryText: string,
) =>
	new CatalogPlanItem({
		featureId,
		included,
		price: new CatalogPlanItemPrice({ amount, billingUnits, interval: "month" }),
		display: { secondaryText },
	})

/** The lab's illustrative catalog, mirroring `apps/api/autumn.config.ts`. */
export const PLANS = [
	new CatalogPlan({
		id: "startup",
		name: "Startup",
		price: { amount: 39, interval: "month" },
		items: [
			meteredItem("logs", 100, 0.3, 1, "then $0.3 per Logs"),
			meteredItem("traces", 100, 0.3, 1, "then $0.3 per Traces"),
			meteredItem("metrics", 100, 0.3, 1, "then $0.3 per Metrics"),
			meteredItem("browser_sessions", 5000, 0.002, 1, "then $0.002 per browser session"),
			meteredItem("product_events", 1_000_000, 0.005, 1000, "then $0.005 per 1,000 product events"),
		],
		customerEligibility: { trialAvailable: true },
	}),
]

export const Model = Schema.Struct({
	quickStart: QuickStart.Model,
	/** Picking a sample plan stands in for checkout. */
	hasPlan: Schema.Boolean,
	isComplete: Schema.Boolean,
	/** Bumped by Restart, so every step remounts. */
	run: Schema.Number,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotStepMessage: { message: QuickStart.Message },
	ClickedRestart: {},
	SimulatedTeamOperation: { message: TeamMessage },
})
export type Message = typeof Message.Type

const Step = Schema.Literals(STEP_IDS)

export const init = (step: (typeof STEP_IDS)[number], run = 0): Model => ({
	quickStart: {
		...QuickStart.init("lab-onboarding").model,
		state: { ...DEFAULT_QUICK_START_STATE, activeStep: step },
		team: ready("Acme", [], true, null),
	},
	hasPlan: step !== "plan",
	isComplete: false,
	run,
})

type Return = { readonly model: Model; readonly commands?: ReadonlyArray<Command.Command<Message>> }

const withQuickStart = (model: Model, quickStart: QuickStart.Model): Model => ({ ...model, quickStart })

/** The team step's own logic, with the Clerk calls swapped for the simulated ones. */
const teamStep = (model: Model, message: TeamMessage): Return => {
	const next = updateTeam(model.quickStart.team, message)
	const operation = next.commands.length === 0 ? null : next.team.pending
	return {
		model: withQuickStart(model, { ...model.quickStart, team: next.team }),
		commands:
			operation === null
				? []
				: [
						SimulateTeamOperation({
							operation,
							value: operation === "rename" ? next.team.name.trim() : next.team.email.trim(),
						}),
					],
	}
}

/** The screen's update without its Commands; the sample team stays, as nothing here loads one. */
const screenStep = (model: Model, message: QuickStart.Message): Model =>
	withQuickStart(model, {
		...QuickStart.update(model.quickStart, message, model.hasPlan).model,
		team: model.quickStart.team,
	})

/** The screen's own update, minus its saves, analytics and navigation; a sample plan's checkout just succeeds. */
const stepMessage = (model: Model, message: QuickStart.Message): Return => {
	switch (message._tag) {
		case "GotTeamMessage":
			return teamStep(model, message.message)
		case "GotPricingMessage":
			return message.message._tag === "ClickedPlan" ? { model: { ...model, hasPlan: true } } : { model }
		case "ClickedContinue":
			if (message.step === "team") return { model: { ...model, isComplete: true } }
			return { model: screenStep(model, message) }
		default:
			return { model: screenStep(model, message) }
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotStepMessage: ({ message: child }) => stepMessage(model, child),
		ClickedRestart: () => ({ model: init("plan", model.run + 1) }),
		SimulatedTeamOperation: ({ message: child }) => teamStep(model, child),
	})

// VIEW

const plansView = Submodel.defineView<null, PricingCards.Message>((_, h) =>
	PricingCardsView.planCards(h, PLANS, null),
)

const complete = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("flex min-h-dvh flex-col items-center justify-center gap-6 px-6 py-16 text-center")],
		[
			icon(h, "MapleMark", { size: 56, className: "text-primary" }),
			h.h1([h.Class("text-2xl font-semibold")], ["Preview complete"]),
			h.p(
				[h.Class("max-w-md text-sm text-muted-foreground")],
				[
					"In the real flow, the last step opens the app. This preview ends here without creating data.",
				],
			),
			button(h, { attributes: [h.OnClick(Message.ClickedRestart())] }, ["Try it again"]),
		],
	)

const stepView = Submodel.defineView<Model, QuickStart.Message>(
	(model, h) =>
		QuickStartView.view(h, model.quickStart, {
			accountCluster: (label) =>
				QuickStartView.accountClusterOf(h, [
					label,
					h.a([h.Href("/lab"), h.Class("text-xs underline underline-offset-4")], ["Exit preview"]),
				]),
			needsRegion: false,
			hasPlan: model.hasPlan,
			orgName: "Acme",
			teamStep: () => QuickStartTeamView.teamStep(h, model.quickStart.team),
			planStep: QuickStartTeamView.planStep(
				h,
				false,
				h.submodel({
					slotId: "lab-onboarding-plans",
					model: null,
					view: plansView,
					toParentMessage: (message) => QuickStart.Message.GotPricingMessage({ message }),
				}),
			),
		}) ?? h.empty,
)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	model.isComplete
		? complete(h)
		: h.div(
				[h.Key(String(model.run))],
				[
					h.submodel({
						slotId: "lab-onboarding-step",
						model,
						view: stepView,
						toParentMessage: (message) => Message.GotStepMessage({ message }),
					}),
				],
			)

/** `?step=stack` opens the preview on a later step. */
const initialStep = (search: string): (typeof STEP_IDS)[number] =>
	Schema.decodeUnknownOption(Step)(new URLSearchParams(search).get("step")).pipe((step) =>
		step._tag === "Some" ? step.value : "plan",
	)

export const lab = defineLabWithFlags("Onboarding", {
	Model,
	Flags: Schema.Struct({ step: Step }),
	flags: Effect.sync(() => ({ step: initialStep(window.location.search) })),
	init: (flags) => ({ model: init(flags.step) }),
	update,
	view,
})

/** The lab's `actions`: a rename or invite succeeds at once and only changes the preview. */
export const SimulateTeamOperation = Command.define("SimulateOnboardingTeamOperation", {
	args: { operation: Schema.Literals(["rename", "invite"]), value: Schema.String },
	messages: [Message.SimulatedTeamOperation],
	execute: ({ operation, value }) =>
		Effect.succeed(
			Message.SimulatedTeamOperation({
				message: TeamMessage.SucceededTeamOperation({ operation, value }),
			}),
		),
})
