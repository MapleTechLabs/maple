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
import {
	completeStep,
	DEFAULT_QUICK_START_STATE,
	pickedRole,
	QuickStartState,
	toggledIntent,
} from "../../page/onboarding/quick-start-state"
import { ready, Team, TeamMessage, updateTeam } from "../../page/onboarding/quick-start-team"

// `/lab/onboarding`: click through onboarding with a
// sample catalog; rename, invites and checkout are simulated, and Restart starts over.

const meteredItem = (featureId: string, included: number, amount: number, billingUnits: number, secondaryText: string) =>
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
	/** 1 to 4 are the wizard's steps; 5 is "Preview complete". */
	step: Schema.Number,
	/** Bumped by Restart, so every step remounts. */
	run: Schema.Number,
	state: QuickStartState,
	workspaceName: Schema.String,
	invitations: Schema.Array(Schema.String),
	team: Team,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotStepMessage: { message: QuickStart.Message },
	ClickedRestart: {},
	ClickedBackToPlans: {},
	SimulatedTeamOperation: { message: TeamMessage },
})
export type Message = typeof Message.Type

export const init = (initialStep: number): Model => ({
	step: initialStep,
	run: 0,
	state: DEFAULT_QUICK_START_STATE,
	workspaceName: "Your workspace",
	invitations: [],
	team: ready("Your workspace", [], true, null),
})

type Return = { readonly model: Model; readonly commands?: ReadonlyArray<Command.Command<Message>> }

const STEP_OF = { role: 1, intent: 2, team: 3, plan: 4 } as const

/** `goTo(step)`: the team step remounts with the name and invitations the preview kept. */
const goTo = (model: Model, step: number): Model => ({
	...model,
	step,
	team: step === 3 ? ready(model.workspaceName, model.invitations, true, null) : model.team,
})

const restart = (model: Model): Model =>
	goTo({ ...init(1), run: model.run + 1 }, 1)

/** The team step's own logic, with the Clerk calls swapped for the simulated ones. */
const teamStep = (model: Model, message: TeamMessage): Return => {
	const next = updateTeam(model.team, message)
	const kept =
		message._tag === "SucceededTeamOperation"
			? message.operation === "rename"
				? { workspaceName: message.value }
				: { invitations: [...model.invitations, message.value] }
			: {}
	const operation = next.commands.length === 0 ? null : next.team.pending
	return {
		model: { ...model, ...kept, team: next.team },
		commands:
			operation === null
				? []
				: [
						SimulateTeamOperation({
							operation,
							value: operation === "rename" ? model.team.name.trim() : model.team.email.trim(),
						}),
					],
	}
}

const stepMessage = (model: Model, message: QuickStart.Message): Return => {
	const answers = model.state.qualifyAnswers
	const withAnswers = (qualifyAnswers: typeof answers): Return => ({ model: { ...model, state: { ...model.state, qualifyAnswers } } })
	switch (message._tag) {
		case "PickedRole":
			return withAnswers(pickedRole(answers, message.role, message.role === "other" ? answers.roleDetail : ""))
		case "ChangedRoleDetail":
			return withAnswers(pickedRole(answers, "other", message.value))
		case "ToggledIntent":
			return withAnswers(toggledIntent(answers, message.intent))
		case "ClickedContinue": {
			const isBlocked =
				(message.step === "role" && (answers.role === null || QuickStart.roleNeedsDetail(model.state))) ||
				(message.step === "intent" && answers.intents.length === 0)
			return isBlocked ? { model } : { model: goTo({ ...model, state: completeStep(model.state, message.step) }, STEP_OF[message.step] + 1) }
		}
		case "ClickedBack":
			return { model: goTo(model, STEP_OF[message.to]) }
		case "GotTeamMessage":
			return teamStep(model, message.message)
		// The sample catalog's checkout and the Enterprise contact both end the preview.
		case "GotPricingMessage":
			return message.message._tag === "ClickedPlan" || message.message._tag === "ClickedEnterpriseContact"
				? { model: goTo(model, 5) }
				: { model }
		default:
			return { model }
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotStepMessage: ({ message: child }) => stepMessage(model, child),
		ClickedRestart: () => ({ model: restart(model) }),
		ClickedBackToPlans: () => ({ model: goTo(model, 4) }),
		SimulatedTeamOperation: ({ message: child }) => teamStep(model, child),
	})

// VIEW

/** The wizard's steps 1 to 4, drawn by the screen's own step views. */
const stepView = Submodel.defineView<Model, QuickStart.Message>((model, h) => {
	switch (model.step) {
		case 1:
			return QuickStartView.roleStep(h, model.state)
		case 2:
			return QuickStartView.intentStep(h, model.state)
		case 3:
			return QuickStartTeamView.teamStep(h, model.team)
		default:
			return QuickStartTeamView.planStep(
				h,
				false,
				h.submodel({
					slotId: "lab-onboarding-plans",
					model: null,
					view: plansView,
					toParentMessage: (message) => QuickStart.Message.GotPricingMessage({ message }),
				}),
			)
	}
})

const plansView = Submodel.defineView<null, PricingCards.Message>((_, h) => PricingCardsView.planCards(h, PLANS, null))

const complete = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("flex flex-1 flex-col items-center justify-center gap-6 px-6 py-16 text-center")],
		[
			icon(h, "MapleMark", { size: 56, className: "text-primary" }),
			h.h1([h.Class("text-2xl font-semibold")], ["Preview complete"]),
			h.p(
				[h.Class("max-w-md text-sm text-muted-foreground")],
				[
					"In the real flow, plan selection opens checkout. This preview ends here without creating data or changing your plan.",
				],
			),
			button(h, { attributes: [h.OnClick(Message.ClickedRestart())] }, ["Try it again"]),
			button(h, { variant: "ghost", attributes: [h.OnClick(Message.ClickedBackToPlans())] }, ["Back to plans"]),
		],
	)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	QuickStartView.onboardingLayout(
		h,
		Math.min(model.step, 4),
		4,
		(label) =>
			QuickStartView.accountClusterOf(h, [
				label,
				h.a([h.Href("/lab"), h.Class("text-xs underline underline-offset-4")], ["Exit preview"]),
			]),
		[
			h.div(
				[h.Class("flex flex-wrap items-center justify-center gap-3 border-y px-4 py-2 text-xs text-muted-foreground")],
				[
					h.span([], ["Onboarding preview · sample pricing · invites and checkout simulated"]),
					button(h, { variant: "ghost", size: "sm", attributes: [h.OnClick(Message.ClickedRestart())] }, ["Restart"]),
				],
			),
			QuickStartView.motionStep(
				h,
				`${model.run}-${model.step}`,
				model.step === 5
					? complete(h)
					: h.submodel({
							slotId: "lab-onboarding-step",
							model,
							view: stepView,
							toParentMessage: (message) => Message.GotStepMessage({ message }),
						}),
			),
		],
	)

/** `?step=N` opens the preview on a later step. */
const initialStep = (search: string): number => {
	const step = Number(new URLSearchParams(search).get("step"))
	return Number.isInteger(step) && step >= 1 && step <= 5 ? step : 1
}

export const lab = defineLabWithFlags("Onboarding", {
	Model,
	Flags: Schema.Struct({ step: Schema.Number }),
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
			Message.SimulatedTeamOperation({ message: TeamMessage.SucceededTeamOperation({ operation, value }) }),
		),
})
