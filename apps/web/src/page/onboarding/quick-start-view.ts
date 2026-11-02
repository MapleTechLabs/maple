import { ONBOARDING_INTENTS } from "../../lib/onboarding-intent"
import {
	filledSurfaces,
	languageDocsOf,
	searchLanguages,
	STACK_LANGUAGES,
	STACK_PLATFORM_IDS,
	STACK_PLATFORMS,
	type StackAnswers,
	type StackItem,
	type StackPlatform,
} from "../../lib/onboarding-stack"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { choiceCard } from "../../ui/choice-card"
import { AppRoute, hrefOf } from "../../route"
import { button } from "../../ui/button"
import { heading } from "../../ui/heading"
import { icon } from "../../ui/icon"
import { searchInput } from "../../ui/search-input"
import { textLink } from "../../ui/text-link"
import { type PixelGlyphName, pixelGlyph } from "./option-card"
import * as CopyButton from "../../ui/copy-button"
import * as GuidedSetup from "../kit/guided-setup"
import { presenceOf, type TelemetrySignalKind } from "../kit/signal-presence"
import { ConnectMessage } from "./quick-start-connect"
import type { LiveFindings } from "./quick-start-live"
import { regionStep } from "./quick-start-region-view"
import { isResumable } from "./quick-start-drawer"
import { drawerView } from "./quick-start-drawer-view"
import * as QuickStartTeamView from "./quick-start-team-view"
import { STEP_BODY_CLASS, STEP_FOOTER_CLASS } from "./step-layout"
import { Message, type Model, MountDitherField } from "./quick-start"
import { type QuickStartState, resolveQuickStartStep, type StepId } from "./quick-start-state"
import { eyebrow, eyebrowVariants } from "../../ui/eyebrow"
import { statusDot } from "../../ui/status-dot"

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
/** The agent prompt's copy state, kept with the snippets'. */
const AGENT_PROMPT_COPY = "agent-prompt"

/** A fade out of blur as each step mounts (`theme.css`); keyed, so a new step plays it again. */
export const ENTER_CLASS = "onboarding-enter"

export const motionStep = <M>(h: HtmlBuilder<M>, step: string, child: Html): Html =>
	h.div([h.Key(step), h.Class(cn("flex flex-1 flex-col", ENTER_CLASS))], [child])

/** How far the backdrop has spread by each step (`/org-required` starts it at 0.55). */
const REACH = {
	region: "0.6",
	plan: "0.7",
	stack: "0.85",
	connect: "1.0",
	team: "1.15",
	live: "1.35",
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
							h.Class("flex items-center gap-2 whitespace-nowrap"),
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
											icon(h, "CheckIcon", {
												size: 12,
												className: "text-severity-info",
											}),
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
	/** Keys the preview card, so it fades in again with each step. */
	step: string
}>

/**
 * One screen high: the header stays, only the step scrolls (its footer pinned to the bottom), and the
 * preview with its backdrop stays put, scrolling on its own when it is taller than the window.
 */
const shell = (h: H, options: ShellOptions, children: ReadonlyArray<Html>): Html => {
	const canvas = h.canvas(
		[
			h.AriaHidden(true),
			h.Class(
				cn(
					"absolute left-0 top-0 size-full",
					options.aside === null &&
						"opacity-60 [mask-image:linear-gradient(to_right,black,transparent_14%)]",
				),
			),
			h.DataAttribute("reach", options.reach),
			h.OnMount(MountDitherField()),
		],
		[],
	)
	return h.div(
		[h.Class("relative flex h-dvh overflow-hidden bg-background text-foreground")],
		[
			...(options.aside === null
				? [
						h.div(
							[
								h.AriaHidden(true),
								h.Class("pointer-events-none absolute inset-0 overflow-hidden"),
							],
							[canvas],
						),
					]
				: []),
			h.div(
				[
					h.Class(
						cn(
							"relative z-10 flex h-dvh min-w-0 flex-col",
							options.aside === null ? "flex-1" : "w-full lg:w-[760px] lg:shrink-0",
						),
					),
				],
				[
					h.header(
						[
							h.Class(
								"flex shrink-0 items-center justify-between gap-4 px-6 py-5 sm:px-12 lg:px-16",
							),
						],
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
					h.main(
						[h.Class("flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain")],
						children,
					),
				],
			),
			...(options.aside === null
				? []
				: [
						h.div(
							[
								h.Class(
									"relative hidden h-dvh flex-1 border-l border-border bg-sidebar lg:block",
								),
							],
							[
								h.div(
									[
										h.AriaHidden(true),
										h.Class("pointer-events-none absolute inset-0 overflow-hidden"),
									],
									[canvas],
								),
								h.div(
									[
										h.Class(
											"absolute inset-0 flex flex-col overflow-y-auto overscroll-contain p-14",
										),
									],
									[
										h.div(
											[
												h.Key(options.step),
												h.Class(
													cn(
														"relative m-auto w-full max-w-[540px] rounded-md border border-border bg-sidebar p-5",
														"onboarding-enter-preview",
													),
												),
											],
											[options.aside],
										),
									],
								),
							],
						),
					]),
		],
	)
}

// STACK

/** A compact pick: one line of label and description, so the whole stack fits on a laptop screen. */
const stackCard = (h: H, item: StackItem, isChecked: boolean, onChange: Message): Html =>
	choiceCard(
		h,
		{ type: "checkbox", isChecked, label: item.label, onChange, className: "items-center gap-3 p-3" },
		[
			h.span(
				[h.AriaHidden(true), h.Class("flex size-7 shrink-0 items-center justify-center")],
				[icon(h, item.icon, { size: 18 })],
			),
			h.span(
				[h.Class("flex min-w-0 flex-1 flex-col")],
				[
					h.span([h.Class("truncate text-sm font-medium")], [item.label]),
					h.span([h.Class("truncate text-xs text-muted-foreground")], [item.description]),
				],
			),
			h.span(
				[
					h.AriaHidden(true),
					h.Class(
						cn(
							"flex size-4 shrink-0 items-center justify-center rounded-sm border",
							isChecked
								? "border-primary bg-primary text-primary-foreground"
								: "border-input",
						),
					),
				],
				isChecked ? [icon(h, "CheckIcon", { size: 12 })] : [],
			),
		],
	)

const STACK_GRID_CLASS = "grid gap-2 sm:grid-cols-2 xl:grid-cols-3"

const stackGroup = (h: H, legend: string, cards: ReadonlyArray<Html>): Html =>
	h.fieldset(
		[h.Class("flex min-w-0 flex-col gap-3")],
		[
			h.legend([h.Class(cn("mb-3", eyebrowVariants({ variant: "label" })))], [legend]),
			h.div([h.Class(STACK_GRID_CLASS)], cards),
		],
	)

const edgeBlur = (h: H, edge: "top" | "bottom"): Html =>
	h.div(
		[h.AriaHidden(true), h.Class(`edge-scroll__edge edge-scroll__edge--${edge}`)],
		[h.span([], []), h.span([], []), h.span([], [])],
	)

/** Three rows of cards show; the rest scroll, and the search narrows them. */
const languageGroup = (h: H, state: QuickStartState, query: string): Html => {
	const { languages } = state.stack
	const matches = searchLanguages(query)
	const card = (language: (typeof matches)[number]) =>
		stackCard(
			h,
			STACK_LANGUAGES[language],
			languages.includes(language),
			Message.ToggledLanguage({ language }),
		)
	return h.fieldset(
		[h.Class("flex min-w-0 flex-col gap-3")],
		[
			h.legend([h.Class("sr-only")], ["Your code"]),
			h.div(
				[h.Class("flex items-center justify-between gap-4")],
				[
					eyebrow(h, { variant: "label", attributes: [h.AriaHidden(true)] }, ["Your code"]),
					searchInput(h, {
						id: "stack-language-search",
						value: query,
						placeholder: "Search languages…",
						ariaLabel: "Search languages",
						onInput: (value) => Message.ChangedLanguageQuery({ query: value }),
						onClear: Message.ChangedLanguageQuery({ query: "" }),
						className: "w-56",
					}),
				],
			),
			matches.length === 0
				? h.div(
						// Same height as the grid, so the section below stays put while typing.
						[h.Class("flex h-[14rem] flex-col gap-3")],
						[
							h.p(
								[h.Class("text-sm text-muted-foreground")],
								[
									`Nothing called "${query.trim()}" yet. Any OpenTelemetry SDK works with Maple:`,
								],
							),
							h.div([h.Class(STACK_GRID_CLASS)], [card("otel")]),
						],
					)
				: h.div(
						[h.Class("edge-scroll -m-1")],
						[
							...(matches.length > 9 ? [edgeBlur(h, "top")] : []),
							h.div(
								[
									// The fourth row peeks out to show it scrolls; padded so a focused card's ring is not clipped.
									h.Class(
										cn(
											STACK_GRID_CLASS,
											"edge-scroll__box h-[14rem] content-start overflow-y-auto overscroll-contain p-1",
										),
									),
								],
								matches.map(card),
							),
							...(matches.length > 9 ? [edgeBlur(h, "bottom")] : []),
						],
					),
		],
	)
}

const backButton = (h: H, to: StepId): Html =>
	button(h, { variant: "ghost", attributes: [h.OnClick(Message.ClickedBack({ to }))] }, [
		icon(h, "ArrowLeftIcon"),
		"Back",
	])

/** The step's actions on the right, with a Back button on the left when there is a step before it. */
const stepFooter = (h: H, children: ReadonlyArray<Html>, back: StepId | null = null): Html =>
	back === null
		? h.div([h.Class(STEP_FOOTER_CLASS)], children)
		: h.div(
				[h.Class(cn(STEP_FOOTER_CLASS, "justify-between"))],
				[backButton(h, back), h.div([h.Class("flex items-center gap-4")], children)],
			)

const stackStep = (h: H, state: QuickStartState, query: string, hasPlan: boolean): Html => {
	const { languages, platforms } = state.stack
	const picked = languages.length + platforms.length
	return h.div(
		[h.Class(STEP_BODY_CLASS)],
		[
			h.div(
				[h.Class("flex flex-col gap-2.5")],
				[
					heading(h, { level: 1, variant: "display" }, ["What are you running?"]),
					h.p(
						[h.Class("text-title leading-relaxed text-muted-foreground")],
						["Pick everything that applies. We set up just those, and you can add more later."],
					),
				],
			),
			languageGroup(h, state, query),
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
			stepFooter(
				h,
				[
					...(picked === 0
						? [
								h.span(
									[h.Class("hidden text-sm text-muted-foreground sm:inline")],
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
				],
				hasPlan ? null : "plan",
			),
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
					eyebrow(h, { variant: "label" }, [`What ${orgName} gets`]),
					h.span(
						[h.Class("font-display text-xl font-semibold")],
						[surfaces.length === 0 ? "Nothing picked yet" : `${surfaces.length} places light up`],
					),
				],
			),
			...(surfaces.length === 0
				? [
						h.p(
							[
								h.Class(
									"rounded-md border border-dashed border-border px-4 py-8 text-center text-xs leading-relaxed text-muted-foreground",
								),
							],
							["Pick a language or platform to see the pages it fills."],
						),
					]
				: [
						h.ul(
							[
								h.Class(
									"flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border bg-background",
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

// CONNECT

const toConnect = (message: ConnectMessage): Message => Message.GotConnectMessage({ message })

/** The picked language's guide for the Instrument tab; without one it keeps the snippet's own. */
const docsFor = (stack: StackAnswers): Readonly<{ docs?: GuidedSetup.InstructionsDocs }> => {
	const docs = languageDocsOf(stack)
	return docs === undefined ? {} : { docs }
}

const providerRow = (h: H, model: Model, platform: StackPlatform): Html => {
	const item = STACK_PLATFORMS[platform]
	const isConnected = model.connect.connected[platform] === true
	return h.li(
		[h.Class("flex items-center gap-3.5 px-4 py-3.5")],
		[
			h.span(
				[
					h.AriaHidden(true),
					h.Class(
						"flex size-9 shrink-0 items-center justify-center rounded-md border border-border",
					),
				],
				[icon(h, item.icon, { size: 18 })],
			),
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
				[
					h.span([h.Class("text-sm font-medium")], [item.label]),
					h.span([h.Class("text-xs text-muted-foreground")], [item.description]),
				],
			),
			isConnected
				? h.div(
						[h.Class("flex items-center gap-3")],
						[
							h.span(
								[h.Class("flex items-center gap-1.5 text-sm text-severity-info")],
								[icon(h, "CircleCheckIcon", { size: 14 }), "Connected"],
							),
							// A push source made after its sheet was dismissed: its one-time token is still there.
							...(isResumable(model.drawer, platform) && model.drawer?.flow.created !== null
								? [
										button(
											h,
											{
												variant: "ghost",
												size: "sm",
												attributes: [
													h.AriaLabel(`Show the ${item.label} token`),
													h.OnClick(Message.ClickedSetUp({ platform })),
												],
											},
											["Show token"],
										),
									]
								: []),
						],
					)
				: button(
						h,
						{
							variant: "outline",
							size: "sm",
							attributes: [
								h.AriaLabel(`Set up ${item.label}`),
								h.OnClick(Message.ClickedSetUp({ platform })),
							],
						},
						["Set up"],
					),
		],
	)
}

export const connectStep = (h: H, model: Model, state: QuickStartState): Html => {
	const { platforms } = state.stack
	const { connect } = model
	return h.div(
		[h.Class(STEP_BODY_CLASS)],
		[
			h.div(
				[h.Class("flex flex-col gap-2.5")],
				[
					heading(h, { level: 1, variant: "display" }, ["Connect your stack"]),
					h.p(
						[h.Class("text-title leading-relaxed text-muted-foreground")],
						[
							"Your code sends traces, logs and metrics with OpenTelemetry. Hand one prompt to your coding agent, or add a few lines by hand.",
						],
					),
				],
			),
			...(platforms.length === 0
				? []
				: [
						h.section(
							[h.Class("flex flex-col gap-3")],
							[
								eyebrow(h, { variant: "label", as: "h2" }, ["Providers"]),
								h.ul(
									[
										h.Class(
											"flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border bg-card",
										),
									],
									platforms.map((platform) => providerRow(h, model, platform)),
								),
							],
						),
					]),
			h.section(
				[h.Class("flex flex-col gap-3")],
				[
					h.div(
						[h.Class("flex items-center justify-between gap-3")],
						[
							eyebrow(h, { variant: "label", as: "h2", className: "flex items-center gap-2" }, [
								"Your code, with OpenTelemetry",
							]),
							// The languages picked, or every SDK there are snippets for when none was.
							h.span(
								[h.AriaHidden(true), h.Class("flex items-center gap-1.5 max-sm:hidden")],
								(state.stack.languages.length === 0
									? ([
											"FrameworkNodejsIcon",
											"FrameworkPythonIcon",
											"FrameworkGoIcon",
											"OpenjdkIcon",
											"RustIcon",
											"GlobeIcon",
										] as const)
									: state.stack.languages.map((language) => STACK_LANGUAGES[language].icon)
								).map((name) =>
									h.span(
										[
											h.Class(
												"flex size-6 items-center justify-center rounded-sm border border-border bg-card",
											),
										],
										[icon(h, name, { size: 14 })],
									),
								),
							),
						],
					),
					GuidedSetup.agentPromptButton(h, {
						apiKey: connect.keys._tag === "Ready" ? connect.keys.privateKey : "",
						copy: connect.snippetCopies[AGENT_PROMPT_COPY] ?? CopyButton.init(),
						toCopyMessage: (message) =>
							toConnect(
								ConnectMessage.GotSnippetCopyMessage({ snippet: AGENT_PROMPT_COPY, message }),
							),
					}),
					GuidedSetup.connectInstructions(h, {
						slot: "onboarding-connect",
						framework: state.selectedFramework ?? "nodejs",
						apiKey: connect.keys._tag === "Ready" ? connect.keys.privateKey : "",
						setupTabs: connect.setupTabs,
						packageTabs: connect.packageTabs,
						snippetCopies: connect.snippetCopies,
						toSetupTabs: (message) => toConnect(ConnectMessage.GotSetupTabsMessage({ message })),
						toPackageTabs: (message) =>
							toConnect(ConnectMessage.GotPackageTabsMessage({ message })),
						toSnippetCopy: (snippet, message) =>
							toConnect(ConnectMessage.GotSnippetCopyMessage({ snippet, message })),
						variant: "boxed",
						...docsFor(state.stack),
					}),
					...(connect.keys._tag === "Failed"
						? [
								h.p(
									[h.Class("text-xs text-muted-foreground")],
									[
										"Couldn't read your ingest key. An admin can copy it from Settings, Ingestion.",
									],
								),
							]
						: []),
				],
			),
			stepFooter(
				h,
				[
					h.span(
						[h.Class("hidden text-sm text-muted-foreground sm:inline")],
						["We keep listening while you move on."],
					),
					button(
						h,
						{ size: "lg", attributes: [h.OnClick(Message.ClickedContinue({ step: "connect" }))] },
						["Continue", icon(h, "ArrowRightIcon", { size: 16 })],
					),
				],
				"stack",
			),
		],
	)
}

const SIGNALS: ReadonlyArray<Readonly<{ signal: TelemetrySignalKind; label: string; waiting: string }>> = [
	{ signal: "traces", label: "Traces", waiting: "Waiting for the first span" },
	{ signal: "logs", label: "Logs", waiting: "Waiting for the first log line" },
	{ signal: "metrics", label: "Metrics", waiting: "Waiting for the first data point" },
	{ signal: "sessions", label: "Sessions", waiting: "Waiting for the first browser session" },
]

/** What has reached Maple so far, re-read every few seconds while the step shows. */
const connectPreview = (h: H, orgName: string, model: Model, state: QuickStartState): Html => {
	const rows = SIGNALS.map((entry) => ({
		...entry,
		presence: presenceOf(model.connect.presence, entry.signal),
	}))
	const arriving = rows.filter((row) => row.presence.status === "present").length
	const providers = state.stack.platforms
	return h.div(
		[h.Class("flex flex-col gap-4"), h.AriaLive("polite")],
		[
			h.div(
				[h.Class("flex items-end justify-between gap-3")],
				[
					h.div(
						[h.Class("flex flex-col gap-1")],
						[
							eyebrow(h, { variant: "label" }, [`Arriving in ${orgName}`]),
							h.span(
								[h.Class("font-display text-xl font-semibold")],
								[
									arriving === 0
										? "Waiting for your first data"
										: `${arriving} of ${rows.length} signals arriving`,
								],
							),
						],
					),
					h.span(
						[
							h.Class(
								"flex items-center gap-1.5 rounded-sm border border-border px-2 py-0.5 text-2xs text-muted-foreground",
							),
						],
						[statusDot(h, { tone: "ok" }), "Listening"],
					),
				],
			),
			h.ul(
				[
					h.Class(
						"flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border bg-background",
					),
				],
				[
					...rows.map((row) =>
						h.li(
							[h.Class("flex items-center gap-3 px-4 py-3")],
							[
								h.span([h.Class("flex-1 text-sm")], [row.label]),
								h.span(
									[
										h.Class(
											cn(
												"text-xs",
												row.presence.status === "present"
													? "text-severity-info"
													: "text-muted-foreground",
											),
										),
									],
									[
										row.presence.status === "present"
											? "Receiving"
											: row.presence.status === "loading"
												? "Checking"
												: row.waiting,
									],
								),
							],
						),
					),
					...providers.map((platform) =>
						h.li(
							[h.Class("flex items-center gap-3 px-4 py-3")],
							[
								h.span(
									[h.AriaHidden(true), h.Class("flex")],
									[icon(h, STACK_PLATFORMS[platform].icon, { size: 14 })],
								),
								h.span([h.Class("flex-1 text-sm")], [STACK_PLATFORMS[platform].label]),
								h.span(
									[
										h.Class(
											cn(
												"text-xs",
												model.connect.connected[platform] === true
													? "text-severity-info"
													: "text-muted-foreground",
											),
										),
									],
									[
										model.connect.connected[platform] === true
											? "Connected"
											: "Not connected yet",
									],
								),
							],
						),
					),
				],
			),
		],
	)
}

// LIVE

type StartCard = Readonly<{
	glyph: PixelGlyphName
	title: string
	finding: string
	action: string
	href: string
}>

const percent = (rate: number): string => `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`

/** Where to look first, each card worded from the org's own last 24 hours when there is something to say. */
const startCards = (findings: LiveFindings | null): ReadonlyArray<StartCard> => [
	{
		glyph: "nodes-3",
		title: "Service map",
		finding:
			findings === null || findings.serviceCount === 0
				? "Draws itself from your first traces: which services call which."
				: `${findings.serviceCount} ${findings.serviceCount === 1 ? "service" : "services"} reporting so far.`,
		action: "Open the map",
		href: hrefOf(AppRoute.ServiceMap({ search: {} })),
	},
	{
		glyph: "square-activity-chart",
		title: "Slowest service",
		finding:
			findings?.slowest == null
				? "Once requests arrive, the slowest one is a click away."
				: `${findings.slowest.serviceName} at ${Math.round(findings.slowest.p95LatencyMs)} ms p95.`,
		action: "See its traces",
		href: hrefOf(
			AppRoute.Traces({
				search: findings?.slowest == null ? {} : { services: [findings.slowest.serviceName] },
			}),
		),
	},
	{
		glyph: "triangle-warning",
		title: "Errors",
		finding:
			findings?.mostErrors == null
				? "Exceptions are grouped into issues as soon as one is thrown."
				: `${findings.mostErrors.serviceName} fails ${percent(findings.mostErrors.errorRate)} of requests.`,
		action: "Triage issues",
		href: hrefOf(AppRoute.Errors({ search: {} })),
	},
]

const chip = (h: H, children: ReadonlyArray<Html | string>): Html =>
	h.li(
		[h.Class("flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs")],
		children,
	)

export const liveStep = (h: H, model: Model, state: QuickStartState, orgName: string): Html => {
	const findings = AsyncData.getOrElse(model.live, (): LiveFindings | null => null)
	const signals = SIGNALS.map((entry) => ({
		...entry,
		presence: presenceOf(model.connect.presence, entry.signal),
	}))
	const arriving = signals.filter((row) => row.presence.status === "present")
	const providers = state.stack.platforms
	const connected = providers.filter((platform) => model.connect.connected[platform] === true)
	// A connected provider is not data yet; what is not connected yet waits here.
	const notConnected = providers.filter((platform) => !connected.includes(platform))
	const isLive = arriving.length > 0
	const invited = model.team.invited.length
	return h.div(
		[h.Class("relative flex flex-1 flex-col items-center px-6 pb-12 pt-10 sm:px-12")],
		[
			h.div(
				[h.Class("flex w-full max-w-4xl flex-col gap-10")],
				[
					h.div(
						[h.Class("flex flex-col items-center gap-3 text-center")],
						[
							h.p(
								[
									h.Class(
										cn(
											"text-sm",
											isLive ? "text-severity-info" : "text-muted-foreground",
										),
									),
								],
								[isLive ? "Data is flowing" : "All set up"],
							),
							heading(
								h,
								{ level: 1, variant: "display" },
								[isLive ? `${orgName} is live` : `${orgName} is ready for its first data`],
							),
							h.ul(
								[
									h.AriaLabel("Connected so far"),
									h.Class("mt-1 flex flex-wrap justify-center gap-2"),
								],
								[
									...arriving.map((row) =>
										chip(h, [
											icon(h, "CircleCheckIcon", {
												size: 12,
												className: "text-severity-info",
											}),
											row.label,
										]),
									),
									...connected.map((platform) =>
										chip(h, [
											icon(h, STACK_PLATFORMS[platform].icon, { size: 12 }),
											STACK_PLATFORMS[platform].label,
										]),
									),
									...(invited === 0
										? []
										: [
												chip(h, [
													`${invited} ${invited === 1 ? "invite" : "invites"} sent`,
												]),
											]),
								],
							),
						],
					),
					h.section(
						[h.Class("flex flex-col gap-3")],
						[
							eyebrow(h, { variant: "label", as: "h2" }, ["Start with your own data"]),
							h.ul(
								[
									h.Class(
										"grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3",
									),
								],
								// The whole card is the link; its glyph and arrow answer the hover.
								startCards(findings).map((card) =>
									h.li(
										[h.Class("flex bg-background")],
										[
											h.a(
												[
													h.Href(card.href),
													h.Class(
														"group flex flex-1 flex-col gap-3.5 p-5 outline-none hover:bg-surface-faint focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-surface-faint",
													),
												],
												[
													pixelGlyph(h, card.glyph, false),
													h.span(
														[h.Class("flex flex-col gap-1")],
														[
															h.span(
																[h.Class("text-title font-medium")],
																[card.title],
															),
															h.span(
																[
																	h.Class(
																		"text-ui leading-relaxed text-muted-foreground",
																	),
																],
																[card.finding],
															),
														],
													),
													h.span(
														[
															h.Class(
																"mt-auto flex items-center gap-1.5 text-ui text-muted-foreground group-hover:text-foreground",
															),
														],
														[
															card.action,
															icon(h, "ArrowRightIcon", {
																size: 12,
																className:
																	"transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none",
															}),
														],
													),
												],
											),
										],
									),
								),
							),
						],
					),
					...(notConnected.length === 0 && arriving.length === signals.length
						? []
						: [
								h.section(
									[h.Class("flex flex-col gap-3")],
									[
										eyebrow(h, { variant: "label", as: "h2" }, ["Still waiting on"]),
										h.ul(
											[
												h.Class(
													"flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border",
												),
											],
											[
												...notConnected.map((platform) =>
													h.li(
														[h.Class("flex items-center gap-3 px-4 py-3")],
														[
															h.span(
																[h.AriaHidden(true), h.Class("flex")],
																[
																	icon(h, STACK_PLATFORMS[platform].icon, {
																		size: 14,
																	}),
																],
															),
															h.span(
																[h.Class("flex-1 text-sm")],
																[
																	`Connect ${STACK_PLATFORMS[platform].label}`,
																],
															),
															button(
																h,
																{
																	variant: "outline",
																	size: "xs",
																	attributes: [
																		h.AriaLabel(
																			`Set up ${STACK_PLATFORMS[platform].label}`,
																		),
																		h.OnClick(
																			Message.ClickedSetUp({
																				platform,
																			}),
																		),
																	],
																},
																["Set up"],
															),
														],
													),
												),
												...(arriving.length > 0
													? []
													: [
															h.li(
																[
																	h.Class(
																		"flex items-center gap-3 px-4 py-3",
																	),
																],
																[
																	icon(h, "ClockIcon", {
																		size: 14,
																		className: "text-muted-foreground",
																	}),
																	h.span(
																		[h.Class("flex-1 text-sm")],
																		["Your first span, log or metric"],
																	),
																	h.span(
																		[
																			h.Class(
																				"flex items-center gap-1.5 text-xs text-muted-foreground",
																			),
																		],
																		[
																			statusDot(h, { tone: "ok" }),
																			"Listening",
																		],
																	),
																],
															),
														]),
											],
										),
									],
								),
							]),
					h.div(
						[h.Class("flex flex-col items-center gap-4")],
						[
							h.div(
								[h.Class("flex max-w-full flex-wrap items-center justify-center gap-2")],
								[
									backButton(h, "team"),
									button(
										h,
										{
											size: "lg",
											attributes: [
												h.OnClick(Message.ClickedContinue({ step: "live" })),
											],
										},
										[
											h.span([h.Class("max-w-64 truncate")], [`Go to ${orgName}`]),
											icon(h, "ArrowRightIcon", { size: 16 }),
										],
									),
								],
							),
							textLink(
								h,
								{
									tone: "muted",
									className: "text-xs",
									href: hrefOf(AppRoute.Alerts({ search: {} })),
								},
								["Or set up your first alert"],
							),
						],
					),
				],
			),
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
	/** The connect drawer's flow shows times in it. */
	timeZone: string
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
		{
			label: "Connect",
			answer: state.completedSteps.connect === true && step !== "connect" ? "Connect" : null,
			isCurrent: step === "connect",
		},
		{
			label: "Team",
			answer: state.completedSteps.team === true && step !== "team" ? "Team" : null,
			isCurrent: step === "team",
		},
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
		step,
	})
	// The drawer portals to the body; any step can hold it (an OAuth return lands on the current one).
	const drawer = drawerView(h, model.drawer, parts.timeZone, (message) =>
		Message.GotDrawerMessage({ message }),
	)
	switch (step) {
		case "region":
			return shell(h, options(null), [motionStep(h, "region", regionStep(h, model.region)), drawer])
		case "plan":
			return shell(h, options(null), [motionStep(h, "plan", parts.planStep), drawer])
		case "stack":
			return shell(h, options(stackPreview(h, parts.orgName, state)), [
				motionStep(h, "stack", stackStep(h, state, model.languageQuery, parts.hasPlan)),
				drawer,
			])
		case "connect":
			return shell(h, options(connectPreview(h, parts.orgName, model, state)), [
				motionStep(h, "connect", connectStep(h, model, state)),
				drawer,
			])
		case "live":
			return shell(h, options(null), [
				motionStep(h, "live", liveStep(h, model, state, parts.orgName)),
				drawer,
			])
		case "team":
			return shell(h, options(QuickStartTeamView.teamPreview(h)), [
				motionStep(h, "team", parts.teamStep(state)),
				drawer,
			])
	}
}
