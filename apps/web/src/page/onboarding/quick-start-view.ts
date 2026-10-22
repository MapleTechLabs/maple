import { ONBOARDING_INTENT_IDS, ONBOARDING_INTENTS, type OnboardingIntent } from "../../lib/onboarding-intent"
import {
	ONBOARDING_ROLE_IDS,
	ONBOARDING_ROLES,
	type OnboardingRole,
	ROLE_DETAIL_MAX_LENGTH,
} from "../../lib/onboarding-role"
import { Option } from "effect"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { eyebrow } from "../../ui/eyebrow"
import { field, type FieldIds, type FieldState, fieldLabel, input } from "../../ui/field"
import { icon } from "../../ui/icon"
import { optionCard, type PixelGlyphName, pixelGlyph } from "./option-card"
import { regionStep } from "./quick-start-region-view"
import { Message, type Model, roleNeedsDetail } from "./quick-start"
import { type QuickStartState, resolveQuickStartStep, STEP_IDS } from "./quick-start-state"

type H = HtmlBuilder<Message>

/** `<Input id="onboarding-role-detail">` under `<FieldLabel htmlFor>`. */
const DETAIL_FIELD: FieldIds = {
	control: "onboarding-role-detail",
	label: "onboarding-role-detail-label",
	error: "onboarding-role-detail-error",
}
const DETAIL_STATE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}

const ROLE_GLYPH = {
	backend: "brackets-curly-dots",
	frontend: "laptop",
	devops_sre: "gear-2",
	eng_leader: "users-2",
	founder: "rocket",
	other: "pen-writing",
} satisfies Record<OnboardingRole, PixelGlyphName>

const INTENT_GLYPH = {
	traces: "square-activity-chart",
	logs: "file",
	metrics: "chart-bar-trend-up",
	errors: "triangle-warning",
	replays: "film",
	service_map: "nodes-3",
	infrastructure: "layers-3",
	alerts: "bell",
} satisfies Record<OnboardingIntent, PixelGlyphName>

const stepLabel = <M>(h: HtmlBuilder<M>, label: string): Html =>
	h.span([h.Class("hidden text-sm text-muted-foreground tabular-nums sm:inline")], [label])

/** `OnboardingLayout`'s right cluster: the step label, then the account actions. */
export const accountClusterOf = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex items-center gap-3")], children)

/** `OnboardingLayout`: the mark, the step pills and the account actions over the step. */
export const onboardingLayout = <M>(
	h: HtmlBuilder<M>,
	currentStep: number,
	totalSteps: number,
	accountCluster: (label: Html) => Html,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[h.Class("relative min-h-screen bg-background flex flex-col overflow-hidden")],
		[
			h.div(
				[
					h.AriaHidden(true),
					h.Class("pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-60"),
					h.Style({
						background:
							"radial-gradient(60% 80% at 50% 0%, hsl(var(--primary) / 0.08) 0%, hsl(var(--primary) / 0.02) 45%, transparent 75%)",
					}),
				],
				[],
			),
			h.div(
				[
					h.AriaHidden(true),
					h.Class(
						"pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent_60%)]",
					),
					h.Style({
						"background-image":
							"radial-gradient(circle at 1px 1px, hsl(var(--foreground) / 0.04) 1px, transparent 0)",
						"background-size": "24px 24px",
					}),
				],
				[],
			),
			h.header(
				[h.Class("relative z-10 flex items-center justify-between px-6 py-5 shrink-0")],
				[
					h.div(
						[h.Class("flex items-center gap-2.5")],
						[
							icon(h, "MapleMark", { size: 26, className: "text-primary shrink-0" }),
							h.span([h.Class("text-base font-semibold tracking-tight")], ["Maple"]),
						],
					),
					h.div(
						[h.Class("flex items-center gap-1.5")],
						Array.from({ length: totalSteps }, (_, index) => stepPill(h, index < currentStep)),
					),
					accountCluster(stepLabel(h, `Step ${currentStep} of ${totalSteps}`)),
				],
			),
			h.main([h.Class("relative z-10 flex-1 flex flex-col")], children),
		],
	)

const roleDetailField = (h: H, state: QuickStartState): Html =>
	field(h, { className: "w-full items-stretch", state: DETAIL_STATE }, [
		fieldLabel(h, { ids: DETAIL_FIELD, state: DETAIL_STATE }, "Your role"),
		input(h, {
			ids: DETAIL_FIELD,
			state: { ...DETAIL_STATE, isFilled: state.qualifyAnswers.roleDetail !== "" },
			attributes: [
				h.Type("text"),
				h.Autocomplete("organization-title"),
				h.Placeholder("e.g. Security engineer"),
				h.Value(state.qualifyAnswers.roleDetail),
				h.Maxlength(ROLE_DETAIL_MAX_LENGTH),
				h.OnInput((value) => Message.ChangedRoleDetail({ value })),
				h.OnKeyDownPreventDefault((key) =>
					key === "Enter" && !roleNeedsDetail(state)
						? Option.some(Message.ClickedContinue({ step: "role" }))
						: Option.none(),
				),
			],
		}),
	])

/** `StepRole`. */
export const roleStep = (h: H, state: QuickStartState): Html => {
	const { role } = state.qualifyAnswers
	return h.div(
		[h.Class("flex flex-1 flex-col items-center justify-center overflow-auto px-6 py-12")],
		[
			h.div(
				[h.Class("flex w-full max-w-3xl flex-col gap-8")],
				[
					h.div(
						[h.Class("space-y-3 text-center")],
						[
							h.div(
								[h.AriaHidden(true), h.Class("mx-auto mb-6 w-fit text-primary")],
								[icon(h, "MapleMark", { size: 56 })],
							),
							eyebrow(h, { variant: "label", className: "text-primary" }, ["Welcome to Maple"]),
							h.h1([h.Class("text-3xl font-semibold tracking-tight")], ["What's your role?"]),
							h.p(
								[h.Class("mx-auto max-w-md text-sm leading-relaxed text-muted-foreground")],
								["Sets the default SDK snippet and the first pages we point you at."],
							),
						],
					),
					h.fieldset(
						[h.Class("grid min-w-0 gap-2.5 sm:grid-cols-2")],
						[
							h.legend([h.Class("sr-only")], ["Your role"]),
							...ONBOARDING_ROLE_IDS.map((id) =>
								optionCard(h, {
									type: "radio",
									name: "onboarding-role",
									isChecked: role === id,
									onChange: Message.PickedRole({ role: id }),
									label: ONBOARDING_ROLES[id].label,
									title: ONBOARDING_ROLES[id].label,
									description: ONBOARDING_ROLES[id].title,
									media: pixelGlyph(h, ROLE_GLYPH[id], role === id),
								}),
							),
						],
					),
					...(role === "other" ? [roleDetailField(h, state)] : []),
					h.p(
						[
							h.AriaLive("polite"),
							h.AriaAtomic(true),
							h.Class("min-h-10 text-center text-xs leading-relaxed text-muted-foreground"),
						],
						[
							role === null
								? "A little about you. Then a look inside."
								: ONBOARDING_ROLES[role].greeting,
						],
					),
					h.div(
						[h.Class("flex items-center justify-end")],
						[
							button(
								h,
								{
									size: "lg",
									className: "min-w-[180px]",
									isDisabled: role === null || roleNeedsDetail(state),
									attributes: [h.OnClick(Message.ClickedContinue({ step: "role" }))],
								},
								["Continue", h.span([h.Class("ml-2")], ["→"])],
							),
						],
					),
				],
			),
		],
	)
}

const backButton = (h: H, to: (typeof STEP_IDS)[number], className?: string): Html =>
	button(h, { variant: "ghost", className, attributes: [h.OnClick(Message.ClickedBack({ to }))] }, [
		icon(h, "ArrowLeftIcon"),
		"Back",
	])

/** `StepIntent`. */
export const intentStep = (h: H, state: QuickStartState): Html => {
	const { intents } = state.qualifyAnswers
	return h.div(
		[h.Class("flex flex-1 flex-col items-center justify-center px-6 py-10")],
		[
			h.div(
				[h.Class("w-full max-w-3xl space-y-7")],
				[
					h.div(
						[h.Class("space-y-3 text-center")],
						[
							h.h1(
								[h.Class("text-3xl font-semibold tracking-tight")],
								["What do you want to see first?"],
							),
							h.p(
								[h.Class("text-sm leading-relaxed text-muted-foreground")],
								["Pick any. Setup guidance follows what you choose."],
							),
						],
					),
					h.fieldset(
						[h.Class("grid min-w-0 gap-2.5 sm:grid-cols-2")],
						[
							h.legend(
								[h.Class("sr-only")],
								["Surfaces to start with — choose any that apply"],
							),
							...ONBOARDING_INTENT_IDS.map((id) =>
								optionCard(h, {
									type: "checkbox",
									isChecked: intents.includes(id),
									onChange: Message.ToggledIntent({ intent: id }),
									label: ONBOARDING_INTENTS[id].label,
									title: ONBOARDING_INTENTS[id].label,
									description: ONBOARDING_INTENTS[id].title,
									media: pixelGlyph(h, INTENT_GLYPH[id], intents.includes(id)),
								}),
							),
						],
					),
					h.div(
						[
							h.Class(
								"flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-b pb-5 text-xs",
							),
							h.AriaLive("polite"),
							h.AriaAtomic(true),
						],
						intents.length === 0
							? [h.span([h.Class("text-muted-foreground")], ["Pick at least one."])]
							: [
									h.span([h.Class("tabular-nums")], [String(intents.length), " selected"]),
									h.span(
										[h.Class("text-muted-foreground")],
										[intents.map((id) => ONBOARDING_INTENTS[id].label).join(" · ")],
									),
								],
					),
					h.div(
						[h.Class("flex items-center justify-between gap-3")],
						[
							backButton(h, "role"),
							button(
								h,
								{
									size: "lg",
									isDisabled: intents.length === 0,
									attributes: [h.OnClick(Message.ClickedContinue({ step: "intent" }))],
								},
								["Continue"],
							),
						],
					),
				],
			),
		],
	)
}

/** Width, not scale: scaling a pill squashes its end caps mid-transition. */
const stepPill = <M>(h: HtmlBuilder<M>, isReached: boolean): Html =>
	h.div(
		[
			h.Class(
				cn(
					"h-1 overflow-hidden rounded-full bg-muted transition-[width] duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
					isReached ? "w-7" : "w-4",
				),
			),
		],
		[
			h.div(
				[
					h.Class(
						cn(
							"h-full origin-left bg-primary transition-transform duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
							isReached ? "scale-x-100" : "scale-x-0",
						),
					),
				],
				[],
			),
		],
	)

/** What the screen draws for its step; the team and plan steps come from their own modules. */
export type QuickStartParts = Readonly<{
	/** The header's right cluster around the step label: the container owns its menus. */
	accountCluster: (label: Html) => Html
	teamStep: (state: QuickStartState) => Html
	planStep: Html
	/** `needsRegion`: the region step holds back the others until the org has one. */
	needsRegion: boolean
}>

/**
 * `MotionStep key={step}` at rest (reduced motion: no slide). A new step is a new element, as
 * AnimatePresence remounts it, so no card is patched over from the previous step.
 */
export const motionStep = <M>(h: HtmlBuilder<M>, step: string, child: Html): Html =>
	h.div(
		[h.Key(step), h.Class("flex flex-1 flex-col"), h.Style({ opacity: "1", transform: "none" })],
		[child],
	)

export const view = (h: H, model: Model, parts: QuickStartParts): Html | null => {
	const state = model.state
	if (state === null) return null
	const step = resolveQuickStartStep(state)
	const regionOffset = model.isRegionStepShown || parts.needsRegion ? 1 : 0
	if (parts.needsRegion)
		return onboardingLayout(h, 1, STEP_IDS.length + regionOffset, parts.accountCluster, [
			motionStep(h, "region", regionStep(h, model.region)),
		])
	const content =
		step === "role"
			? roleStep(h, state)
			: step === "intent"
				? intentStep(h, state)
				: step === "team"
					? parts.teamStep(state)
					: parts.planStep
	return onboardingLayout(
		h,
		STEP_IDS.indexOf(step) + 1 + regionOffset,
		STEP_IDS.length + regionOffset,
		parts.accountCluster,
		[motionStep(h, step, content)],
	)
}
