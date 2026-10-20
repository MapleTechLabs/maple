import type { V2OnboardingChecklist, V2OnboardingChecklistStep } from "@maple/domain/http/v2"
import { formatCountdown } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { DateTime, Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../ui/button"
import { badge } from "../ui/display"
import { icon } from "../ui/icon"
import { iconButton } from "../ui/icon-button"
import { meter } from "../ui/meter"
import * as PopoverView from "../ui/popover"
import { Message, type Model } from "./onboarding-checklist"

type H = HtmlBuilder<Message>

const credits = (checklist: V2OnboardingChecklist): string => `$${checklist.reward_amount_usd}`

const deadlineOf = (checklist: V2OnboardingChecklist): number | null =>
	checklist.deadline_at === null
		? null
		: Option.match(DateTime.make(checklist.deadline_at), { onNone: () => null, onSome: DateTime.toEpochMillis })

/** `ProgressChip`: `2/5`, written out. */
const progressChip = (h: H, completed: number, total: number): Html =>
	badge(
		h,
		{
			pill: true,
			size: "xs",
			mono: true,
			className: cn(
				"text-2xs font-semibold sm:text-2xs",
				completed === total ? "bg-primary text-primary-foreground" : "bg-primary/15 text-primary",
			),
		},
		[String(completed), "/", String(total)],
	)

/** `RewardCallout`: the one-time pointer under the pill. */
const rewardCallout = (h: H, checklist: V2OnboardingChecklist): Html =>
	h.div(
		[
			h.Role("status"),
			h.Class(
				"absolute top-full right-0 z-40 mt-3 w-max max-w-[calc(100vw-1rem)] rounded-lg border border-primary/40 bg-popover text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-top-1",
			),
		],
		[
			h.span(
				[
					h.Class("absolute -top-1.5 right-6 size-3 rotate-45 border-t border-l border-primary/40 bg-popover"),
					h.AriaHidden(true),
				],
				[],
			),
			h.div(
				[h.Class("flex items-start gap-2 p-3 pr-2")],
				[
					h.button(
						[
							h.Type("button"),
							h.OnClick(Message.ClickedPointer()),
							h.Class(
								"min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
							),
						],
						[
							h.span([h.Class("block whitespace-nowrap text-sm font-semibold")], ["Finish the onboarding list"]),
							h.span(
								[h.Class("mt-0.5 block text-xs text-muted-foreground")],
								["and get ", credits(checklist), " in credits."],
							),
						],
					),
					iconButton(
						h,
						{
							label: "Got it",
							className: "-mt-1 shrink-0 text-muted-foreground",
							attributes: [h.OnClick(Message.ClickedGotIt())],
						},
						[icon(h, "XmarkIcon")],
					),
				],
			),
		],
	)

const optionalTag = (h: H): Html => badge(h, { variant: "meta", size: "xs", pill: true }, ["Optional"])

/** `StepRow`: a done step struck through, an open one linking to where it is done. */
const stepRow = (h: H, step: V2OnboardingChecklistStep, index: number): Html =>
	step.completed
		? h.li(
				[h.Class("flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted-foreground")],
				[
					icon(h, "CircleCheckIcon", { size: 18, className: "shrink-0 text-primary" }),
					h.span(
						[h.Class("min-w-0 flex-1 leading-snug line-through decoration-muted-foreground/40")],
						[step.title],
					),
					...(step.optional ? [optionalTag(h)] : []),
				],
			)
		: h.li(
				[],
				[
					h.a(
						[
							h.Href(step.href),
							h.OnClick(Message.ClickedStep()),
							h.Class(
								"group flex items-center gap-3 rounded-md px-2 py-2 text-sm text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
							),
						],
						[
							h.span(
								[
									h.Class(
										"flex size-4.5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 font-mono text-3xs text-muted-foreground transition-colors group-hover:border-primary group-hover:text-primary",
									),
									h.AriaHidden(true),
								],
								[String(index)],
							),
							h.span([h.Class("min-w-0 flex-1 leading-snug")], [step.title]),
							...(step.optional ? [optionalTag(h)] : []),
							icon(h, "ArrowRightIcon", {
								size: 14,
								className:
									"shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground",
							}),
						],
					),
				],
			)

/** `OnboardingChecklistPanel`: the reward, the progress meter, the steps and the footer. */
const panel = (h: H, model: Model, checklist: V2OnboardingChecklist): ReadonlyArray<Html> => {
	const isClaimed = model.isJustClaimed || checklist.status === "claimed"
	const deadlineMs = deadlineOf(checklist)
	const timeLeft = deadlineMs === null ? null : formatCountdown(deadlineMs - model.nowMs, { fixedHours: true })
	const progress = checklist.total_count === 0 ? 0 : checklist.completed_count / checklist.total_count
	const amount = credits(checklist)
	return [
		h.div(
			[],
			[
				h.div(
					[h.Class("relative space-y-3 border-b bg-primary/[0.06] px-4 pt-4 pb-3")],
					[
						h.div(
							[h.Class("flex items-start gap-3")],
							[
								h.span(
									[
										h.Class(
											"flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/15 text-primary",
										),
									],
									[icon(h, isClaimed ? "CircleCheckIcon" : "RocketIcon", { size: 18 })],
								),
								h.div(
									[h.Class("min-w-0 space-y-1")],
									[
										h.h3(
											[h.Class("text-base font-semibold leading-tight")],
											[isClaimed ? `${amount} in credits added` : `Get ${amount} in credits`],
										),
										h.p(
											[h.Class("text-xs leading-relaxed text-muted-foreground")],
											[
												isClaimed
													? `${amount} in credits applied. It comes off your next invoice.`
													: "Finish these steps within 24 hours of creating your org and we'll credit your balance.",
											],
										),
									],
								),
							],
						),
						meter(h, { value: progress, minVisible: 0, className: "bg-primary/15", fillClassName: "bg-primary" }),
					],
				),
				h.ol([h.Class("space-y-0.5 p-2")], checklist.steps.map((step, index) => stepRow(h, step, index + 1))),
				h.div(
					[h.Class("flex items-center justify-between gap-3 border-t px-4 py-3 text-xs")],
					panelFooter(h, model, checklist, isClaimed, timeLeft),
				),
			],
		),
	]
}

/** The pill: shown while the window is open (or the credit just claimed in this popover). */
export const view = Submodel.defineView<Model, Message>((model, h) => {
	const checklist = model.checklist
	if (checklist === null) return null
	const isActive = checklist.status === "in_progress" || checklist.status === "claimable"
	const deadlineMs = deadlineOf(checklist)
	const isWindowOpen = checklist.status === "claimable" || (deadlineMs !== null && deadlineMs >= model.nowMs)
	if (!model.isJustClaimed && !(isActive && isWindowOpen)) return null
	const isClaimable = checklist.status === "claimable"
	return h.submodel({
		slotId: "onboarding-checklist-popover",
		model: model.popover,
		view: PopoverView.view,
		viewInputs: {
			className: "w-[22rem] max-w-[calc(100vw-1rem)] p-0",
			toContent: () => (model.popover.isOpen ? panel(h, model, checklist) : []),
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("relative")],
					[
						...withTrigger(
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									className: cn(
										"gap-2 border-primary/40 bg-primary/10 text-foreground hover:bg-primary/15",
										isClaimable && "border-primary bg-primary/20",
									),
									slot: "popover-trigger",
									attributes: trigger,
								},
								[
									icon(h, "StarIcon", { className: "text-primary" }),
									isClaimable || deadlineMs === null
										? h.span([], ["Claim ", credits(checklist), " credits"])
										: h.span(
												[h.Class("font-mono tabular-nums")],
												[formatCountdown(deadlineMs - model.nowMs, { fixedHours: true })],
											),
									progressChip(h, checklist.completed_count, checklist.total_count),
								],
							),
						),
						...(!model.isSeen && !model.popover.isOpen ? [rewardCallout(h, checklist)] : []),
					],
				),
		},
		toParentMessage: (message) => Message.GotPopoverMessage({ message }),
	})
})

const panelFooter = (h: H, model: Model, checklist: V2OnboardingChecklist, isClaimed: boolean, timeLeft: string | null): ReadonlyArray<Html> => {
	if (isClaimed)
		return [
			h.span([h.Class("text-muted-foreground")], ["You're all set."]),
			button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedDone())] }, ["Done"]),
		]
	if (checklist.status === "claimable")
		return model.isAdmin
			? [
					h.span(
						[h.Class(cn("text-muted-foreground", model.claimError !== null && "text-severity-error"))],
						[model.claimError ?? "Every step is done."],
					),
					button(h, { size: "sm", isLoading: model.isClaimPending, attributes: [h.OnClick(Message.ClickedClaim())] }, [
						"Claim ",
						credits(checklist),
						" credits",
					]),
				]
			: [h.span([h.Class("text-muted-foreground")], ["All done. Ask an org admin to claim the credits."])]
	return [
		h.span(
			[h.Class("font-mono tabular-nums text-muted-foreground")],
			[String(checklist.completed_count), " of ", String(checklist.total_count), " done"],
		),
		...(timeLeft === null
			? []
			: [
					h.span(
						[h.Class("inline-flex items-center gap-1 font-mono font-medium tabular-nums text-primary")],
						[icon(h, "ClockIcon", { size: 12 }), timeLeft],
					),
				]),
	]
}
