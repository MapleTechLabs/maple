import { TONE_TEXT } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"
import { TRIAL_DURATION_DAYS } from "../../lib/billing/plans"
import { button } from "../../ui/button"
import { eyebrow } from "../../ui/eyebrow"
import { panel } from "../../ui/panel"
import { skeleton } from "../../ui/skeleton"
import { icon } from "../../ui/icon"
import { input } from "../../ui/input"
import { label } from "../../ui/label"
import { Message } from "./quick-start"
import { isAlreadyInvited, isNameDirty, type Team, TeamMessage } from "./quick-start-team"

type H = HtmlBuilder<Message>

const toTeam = (message: TeamMessage) => Message.GotTeamMessage({ message })

const nameForm = (h: H, team: Team, isBusy: boolean): Html =>
	h.form(
		[h.Class("space-y-3"), h.OnSubmit(toTeam(TeamMessage.SubmittedRename()))],
		[
			label(h, { attributes: [h.For("onboarding-workspace-name")] }, ["Workspace name"]),
			h.div(
				[h.Class("flex flex-wrap gap-2")],
				[
					input(h, {
						id: "onboarding-workspace-name",
						type: "text",
						className: "min-w-40 flex-1",
						isDisabled: !team.canManage || isBusy,
						attributes: [
							h.Autocomplete("organization"),
							h.Value(team.name),
							h.Required(true),
							h.Maxlength(256),
							h.OnInput((value) => toTeam(TeamMessage.ChangedWorkspaceName({ value }))),
						],
					}),
					button(
						h,
						{
							type: "submit",
							variant: "outline",
							isLoading: team.pending === "rename",
							isDisabled: !team.canManage || isBusy || team.name.trim() === "" || !isNameDirty(team),
						},
						["Save name"],
					),
				],
			),
		],
	)

const invitedList = (h: H, invited: ReadonlyArray<string>): ReadonlyArray<Html> =>
	invited.length === 0
		? []
		: [
				h.ul(
					[h.AriaLabel("Pending invitations"), h.Class("space-y-2")],
					invited.map((address) =>
						h.li(
							[h.Key(address), h.Class("flex items-center gap-2 text-xs")],
							[
								icon(h, "CircleCheckIcon", { size: 14, className: "shrink-0 text-primary" }),
								h.span([h.Class("min-w-0 break-all")], [address]),
								h.span([h.Class("ml-auto text-muted-foreground")], ["Invited"]),
							],
						),
					),
				),
			]

/** `StepTeamConnected`: the loading line while Clerk reads the org, then `StepTeam`. */
export const teamStep = (h: H, team: Team): Html => {
	if (!team.isLoaded)
		return h.output([h.Class("p-12 text-center text-sm text-muted-foreground")], ["Loading your workspace…"])
	const isBusy = team.pending !== null
	return h.div(
		[h.Class("flex flex-1 flex-col items-center justify-center px-6 py-12")],
		[
			h.div(
				[h.Class("w-full max-w-xl space-y-8")],
				[
					h.div(
						[h.Class("space-y-3 text-center")],
						[
							h.h1([h.Class("text-3xl font-semibold tracking-tight")], ["Bring your team"]),
							h.p(
								[h.Class("text-sm leading-relaxed text-muted-foreground")],
								[
									"A shared place for the people behind your services.",
									h.br([]),
									"Flying solo? You can invite teammates later.",
								],
							),
						],
					),
					...(team.unavailableReason === null
						? []
						: [h.p([h.Class("text-sm text-muted-foreground")], [team.unavailableReason])]),
					nameForm(h, team, isBusy),
					inviteForm(h, team, isBusy),
					...invitedList(h, team.invited),
					h.div(
						[h.AriaLive("polite"), h.AriaAtomic(true), h.Class("min-h-5 text-xs")],
						[
							h.p(
								[h.Class(team.feedback?.isError === true ? TONE_TEXT.crit : "text-muted-foreground")],
								team.feedback === null ? [] : [team.feedback.message],
							),
						],
					),
					h.div(
						[h.Class("flex flex-wrap items-center justify-between gap-3")],
						[
							button(
								h,
								{ variant: "ghost", isDisabled: isBusy, attributes: [h.OnClick(Message.ClickedBack({ to: "intent" }))] },
								[icon(h, "ArrowLeftIcon"), "Back"],
							),
							button(
								h,
								{ size: "lg", isDisabled: isBusy, attributes: [h.OnClick(Message.ClickedContinue({ step: "team" }))] },
								[isNameDirty(team) || team.email.trim() !== "" ? "Skip for now" : "Continue to plans"],
							),
						],
					),
				],
			),
		],
	)
}

/** `PricingSkeleton`: while the customer is still loading. */
const pricingSkeleton = (h: H): Html =>
	h.div(
		[
			h.Role("status"),
			h.AriaLabel("Loading plans"),
			h.Class("grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl mx-auto"),
		],
		[0, 1].map(() =>
			panel(h, { className: "gap-4 p-6" }, [
				skeleton(h, "h-5 w-24"),
				skeleton(h, "h-8 w-32"),
				h.div(
					[h.Class("space-y-2 pt-2")],
					[
						skeleton(h, "h-3 w-full"),
						skeleton(h, "h-3 w-5/6"),
						skeleton(h, "h-3 w-4/6"),
						skeleton(h, "h-3 w-3/6"),
					],
				),
				skeleton(h, "h-10 w-full rounded-md"),
			]),
		),
	)

/** `StepPlan` / `StepPlanLayout`: the trial pitch over the pricing cards, and Back. */
export const planStep = (h: H, isCustomerLoading: boolean, pricing: Html): Html =>
	h.div(
		[h.Class("flex-1 flex flex-col items-center px-6 py-12 overflow-auto")],
		[
			h.div(
				[h.Class("w-full max-w-5xl")],
				[
					h.div(
						[h.Class("text-center mb-10")],
						[
							eyebrow(h, { variant: "label", className: "text-primary" }, ["Pick a plan"]),
							h.h2([h.Class("text-3xl font-semibold tracking-tight mt-2")], ["Pick a plan to keep going"]),
							h.p(
								[h.Class("text-muted-foreground text-sm mt-3 max-w-lg mx-auto")],
								[
									"Start a ",
									String(TRIAL_DURATION_DAYS),
									"-day free trial: we'll save your card now and won't charge until day ",
									String(TRIAL_DURATION_DAYS),
									". Cancel anytime from settings.",
								],
							),
						],
					),
					isCustomerLoading ? pricingSkeleton(h) : pricing,
					h.div(
						[h.Class("mt-8 flex items-center justify-start")],
						[
							button(
								h,
								{ variant: "ghost", className: "gap-2", attributes: [h.OnClick(Message.ClickedBack({ to: "team" }))] },
								[icon(h, "ArrowLeftIcon"), "Back"],
							),
						],
					),
				],
			),
		],
	)

const inviteForm = (h: H, team: Team, isBusy: boolean): Html =>
	h.form(
		[h.Class("space-y-3 border-t pt-6"), h.OnSubmit(toTeam(TeamMessage.SubmittedInvite()))],
		[
			label(h, { attributes: [h.For("onboarding-teammate-email")] }, [
				"Invite a teammate",
				" ",
				h.span([h.Class("font-normal text-muted-foreground")], ["(optional)"]),
			]),
			h.div(
				[h.Class("flex flex-wrap gap-2")],
				[
					input(h, {
						id: "onboarding-teammate-email",
						type: "email",
						className: "min-w-40 flex-1",
						isDisabled: !team.canManage || isBusy,
						attributes: [
							h.Autocomplete("email"),
							h.Placeholder("teammate@company.com"),
							h.Value(team.email),
							h.Required(true),
							h.AriaDescribedBy("onboarding-invite-help"),
							h.OnInput((value) => toTeam(TeamMessage.ChangedTeammateEmail({ value }))),
						],
					}),
					button(
						h,
						{
							type: "submit",
							variant: "outline",
							isLoading: team.pending === "invite",
							isDisabled: !team.canManage || isBusy || team.email.trim() === "" || isAlreadyInvited(team),
						},
						["Send invitation"],
					),
				],
			),
			h.p(
				[h.Id("onboarding-invite-help"), h.Class("text-xs leading-relaxed text-muted-foreground")],
				[
					isAlreadyInvited(team)
						? "This teammate already has a pending invitation."
						: "They’ll receive an email invitation to join this workspace as a member.",
				],
			),
		],
	)
