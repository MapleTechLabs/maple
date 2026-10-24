import { ONBOARDING_INTENTS } from "../../lib/onboarding-intent"
import {
	filledSurfaces,
	STACK_LANGUAGE_IDS,
	STACK_LANGUAGES,
	STACK_PLATFORM_IDS,
	STACK_PLATFORMS,
	type StackItem,
} from "../../lib/onboarding-stack"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import { optionCard, type PixelGlyphName, pixelGlyph } from "./option-card"
import { regionStep } from "./quick-start-region-view"
import { Message, type Model, MountDitherField } from "./quick-start"
import { type QuickStartState, resolveQuickStartStep, type StepId } from "./quick-start-state"

// `/quick-start`: each step's form on the left and, where it has one, a preview of what it sets up on
// the right, over the dithered backdrop that spreads a little further every step.

type H = HtmlBuilder<Message>

/** `OnboardingLayout`'s right cluster: the progress trail, then the account actions. */
export const accountClusterOf = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex items-center gap-3")], children)

/**
 * `MotionStep key={step}` at rest (reduced motion: no slide). A new step is a new element, as
 * AnimatePresence remounts it, so no card is patched over from the previous step.
 */
export const motionStep = <M>(h: HtmlBuilder<M>, step: string, child: Html): Html =>
	h.div(
		[h.Key(step), h.Class("flex flex-1 flex-col"), h.Style({ opacity: "1", transform: "none" })],
		[child],
	)

/** How far the backdrop has spread by each step (`/org-required` starts it at 0.55). */
const REACH = {
	region: "0.6",
	plan: "0.7",
	stack: "0.85",
	team: "1.05",
} as const satisfies Record<StepId | "region", string>

type TrailItem = Readonly<{ label: string; answer: string | null; isCurrent: boolean }>

/** The quiet progress line: done steps show their answer, the current one is underlined. */
const trail = (h: H, items: ReadonlyArray<TrailItem>): Html =>
	h.nav(
		[h.AriaLabel("Onboarding progress"), h.Class("hidden items-center gap-2 text-xs md:flex")],
		[
			h.ol(
				[h.Class("flex items-center gap-2")],
				items.map((item, index) =>
					h.li(
						[
							h.Class("flex items-center gap-2"),
							...(item.isCurrent ? [h.AriaCurrent("step")] : []),
						],
						[
							...(index === 0
								? []
								: [h.span([h.AriaHidden(true), h.Class("text-input")], ["/"])]),
							item.answer === null
								? h.span(
										[
											h.Class(
												cn(
													item.isCurrent
														? "text-foreground underline underline-offset-4"
														: "text-muted-foreground",
												),
											),
										],
										[item.label],
									)
								: h.span(
										[h.Class("flex items-center gap-1.5 text-muted-foreground")],
										[
											icon(h, "CheckIcon", { size: 12, className: "text-success" }),
											item.answer,
										],
									),
						],
					),
				),
			),
		],
	)

type ShellOptions = Readonly<{
	accountCluster: (label: Html) => Html
	trail: Html
	reach: string
	/** The step's preview; without one the step takes the whole width. */
	aside: Html | null
}>

const shell = (h: H, options: ShellOptions, children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("relative flex min-h-dvh bg-background text-foreground")],
		[
			h.div(
				[
					h.Class(
						cn(
							"relative z-10 flex min-w-0 flex-col",
							options.aside === null ? "flex-1" : "w-full lg:w-[760px] lg:shrink-0",
						),
					),
				],
				[
					h.header(
						[h.Class("flex items-center justify-between gap-4 px-6 py-5 sm:px-12 lg:px-16")],
						[
							h.div(
								[h.Class("flex items-center gap-2")],
								[
									h.span(
										[h.AriaHidden(true), h.Class("text-primary")],
										[icon(h, "MapleMark", { size: 20 })],
									),
									h.span(
										[h.Class("font-display text-lg font-semibold tracking-tight")],
										["maple"],
									),
								],
							),
							options.accountCluster(options.trail),
						],
					),
					h.main([h.Class("flex flex-1 flex-col")], children),
				],
			),
			h.div(
				[
					h.Class(
						cn(
							"pointer-events-none overflow-hidden",
							options.aside === null
								? "absolute inset-0"
								: "relative hidden h-dvh flex-1 items-center justify-center border-l border-border bg-sidebar p-14 lg:sticky lg:top-0 lg:flex",
						),
					),
				],
				[
					h.canvas(
						[
							h.AriaHidden(true),
							h.Class(
								cn(
									"absolute inset-0 size-full",
									options.aside === null &&
										"opacity-60 [mask-image:linear-gradient(to_right,black,transparent_14%)]",
								),
							),
							h.DataAttribute("reach", options.reach),
							h.OnMount(MountDitherField()),
						],
						[],
					),
					...(options.aside === null
						? []
						: [
								h.div(
									[
										h.Class(
											"pointer-events-auto relative w-full max-w-[540px] rounded-2xl border border-border bg-sidebar p-5",
										),
									],
									[options.aside],
								),
							]),
				],
			),
		],
	)

// STACK

const stackCard = (h: H, item: StackItem, isChecked: boolean, onChange: Message): Html =>
	optionCard(h, {
		type: "checkbox",
		isChecked,
		onChange,
		label: item.label,
		title: item.label,
		description: item.description,
		media: h.span(
			[
				h.AriaHidden(true),
				h.Class("flex size-9 shrink-0 items-center justify-center rounded-md border border-border"),
			],
			[icon(h, item.icon, { size: 18 })],
		),
	})

const stackGroup = (h: H, legend: string, cards: ReadonlyArray<Html>): Html =>
	h.fieldset(
		[h.Class("flex min-w-0 flex-col gap-3")],
		[
			h.legend([h.Class("mb-3 text-2xs uppercase tracking-widest text-muted-foreground")], [legend]),
			h.div([h.Class("grid gap-2.5 sm:grid-cols-2 2xl:grid-cols-3")], cards),
		],
	)

const stepFooter = (h: H, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("mt-auto flex items-center justify-end gap-4 border-t border-border pt-5")], children)

const stackStep = (h: H, state: QuickStartState): Html => {
	const { languages, platforms } = state.stack
	const picked = languages.length + platforms.length
	return h.div(
		[h.Class("flex flex-1 flex-col gap-8 px-6 pb-8 pt-4 sm:px-12 lg:px-16")],
		[
			h.div(
				[h.Class("flex flex-col gap-2.5")],
				[
					h.h1(
						[h.Class("font-display text-3xl font-semibold tracking-tight")],
						["What are you running?"],
					),
					h.p(
						[h.Class("text-[15px] leading-relaxed text-muted-foreground")],
						["Pick everything that applies. We set up just those, and you can add more later."],
					),
				],
			),
			stackGroup(
				h,
				"Your code",
				STACK_LANGUAGE_IDS.map((language) =>
					stackCard(
						h,
						STACK_LANGUAGES[language],
						languages.includes(language),
						Message.ToggledLanguage({ language }),
					),
				),
			),
			stackGroup(
				h,
				"Where it runs",
				STACK_PLATFORM_IDS.map((platform) =>
					stackCard(
						h,
						STACK_PLATFORMS[platform],
						platforms.includes(platform),
						Message.ToggledPlatform({ platform }),
					),
				),
			),
			stepFooter(h, [
				...(picked === 0
					? [
							h.span(
								[h.Class("text-sm text-muted-foreground")],
								["Not sure yet? You can skip this."],
							),
						]
					: []),
				button(
					h,
					{
						size: "lg",
						variant: picked === 0 ? "outline" : "default",
						attributes: [h.OnClick(Message.ClickedContinue({ step: "stack" }))],
					},
					[picked === 0 ? "Skip for now" : "Continue", icon(h, "ArrowRightIcon", { size: 16 })],
				),
			]),
		],
	)
}

const INTENT_GLYPH = {
	traces: "square-activity-chart",
	logs: "file",
	metrics: "chart-bar-trend-up",
	errors: "triangle-warning",
	replays: "film",
	service_map: "nodes-3",
	infrastructure: "layers-3",
	alerts: "bell",
} as const satisfies Record<keyof typeof ONBOARDING_INTENTS, PixelGlyphName>

/** What the picks fill in Maple, each surface with the picks behind it. */
const stackPreview = (h: H, orgName: string, state: QuickStartState): Html => {
	const surfaces = filledSurfaces(state.stack)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			h.div(
				[h.Class("flex flex-col gap-1")],
				[
					h.span(
						[h.Class("text-2xs uppercase tracking-widest text-muted-foreground")],
						[`What ${orgName} gets`],
					),
					h.span(
						[h.Class("font-display text-xl font-semibold")],
						[
							surfaces.length === 0
								? "Pick what you run to see it here"
								: `${surfaces.length} places light up`,
						],
					),
				],
			),
			...(surfaces.length === 0
				? []
				: [
						h.ul(
							[
								h.Class(
									"flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-background",
								),
							],
							surfaces.map((surface) =>
								h.li(
									[h.Class("flex items-center gap-3.5 px-4 py-3")],
									[
										pixelGlyph(h, INTENT_GLYPH[surface.intent], true),
										h.div(
											[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
											[
												h.span(
													[h.Class("text-sm font-medium")],
													[ONBOARDING_INTENTS[surface.intent].label],
												),
												h.span(
													[h.Class("text-xs text-muted-foreground")],
													[ONBOARDING_INTENTS[surface.intent].title],
												),
											],
										),
										surface.sources.length === 0
											? h.span(
													[h.Class("shrink-0 text-2xs text-muted-foreground")],
													["On everything"],
												)
											: h.span(
													[
														h.Class("flex shrink-0 items-center gap-1"),
														h.Title(
															surface.sources
																.map((source) => source.label)
																.join(", "),
														),
													],
													surface.sources.map((source) =>
														h.span(
															[
																h.Class(
																	"flex size-6 items-center justify-center rounded-sm border border-border",
																),
															],
															[icon(h, source.icon, { size: 12 })],
														),
													),
												),
									],
								),
							),
						),
					]),
		],
	)
}

/** What the screen draws for its step; the team and plan steps come from their own modules. */
export type QuickStartParts = Readonly<{
	/** The header's right cluster around the trail: the container owns its menus. */
	accountCluster: (label: Html) => Html
	teamStep: (state: QuickStartState) => Html
	planStep: Html
	/** `needsRegion`: the region step holds back the others until the org has one. */
	needsRegion: boolean
	/** The org already holds a plan, so its step is done and skipped. */
	hasPlan: boolean
	orgName: string
}>

const trailOf = (
	state: QuickStartState,
	parts: QuickStartParts,
	step: StepId | "region",
): ReadonlyArray<TrailItem> => {
	const picks = state.stack.languages.length + state.stack.platforms.length
	return [
		{ label: "Name", answer: parts.orgName, isCurrent: false },
		{ label: "Plan", answer: parts.hasPlan ? "Plan" : null, isCurrent: step === "plan" },
		{
			label: "Stack",
			answer:
				state.completedSteps.stack === true && step !== "stack"
					? picks === 0
						? "Skipped"
						: `${picks} picked`
					: null,
			isCurrent: step === "stack",
		},
		{ label: "Team", answer: null, isCurrent: step === "team" },
	]
}

export const view = (h: H, model: Model, parts: QuickStartParts): Html | null => {
	const state = model.state
	if (state === null) return null
	const step = parts.needsRegion ? "region" : resolveQuickStartStep(state, parts.hasPlan)
	const options = (aside: Html | null): ShellOptions => ({
		accountCluster: parts.accountCluster,
		trail: trail(h, trailOf(state, parts, step)),
		reach: REACH[step],
		aside,
	})
	switch (step) {
		case "region":
			return shell(h, options(null), [motionStep(h, "region", regionStep(h, model.region))])
		case "plan":
			return shell(h, options(null), [motionStep(h, "plan", parts.planStep)])
		case "stack":
			return shell(h, options(stackPreview(h, parts.orgName, state)), [
				motionStep(h, "stack", stackStep(h, state)),
			])
		case "team":
			return shell(h, options(null), [motionStep(h, "team", parts.teamStep(state))])
	}
}
