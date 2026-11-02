import { cn } from "@maple/ui/lib/utils"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"
import { TRIAL_DURATION_DAYS } from "../../lib/billing/plans"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { heading } from "../../ui/heading"
import { eyebrow } from "../../ui/eyebrow"
import { panel } from "../../ui/panel"
import { skeleton } from "../../ui/skeleton"
import { icon, type IconName } from "../../ui/icon"
import { input } from "../../ui/input"
import { label } from "../../ui/label"
import { Message } from "./quick-start"
import { STEP_BODY_CLASS, STEP_FOOTER_CLASS } from "./step-layout"
import { isAlreadyInvited, type Team, TeamMessage } from "./quick-start-team"

type H = HtmlBuilder<Message>

const toTeam = (message: TeamMessage) => Message.GotTeamMessage({ message })

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

type Tool = Readonly<{ icon: IconName; name: string; line: string; action: string; href: string }>

/** Where Maple shows up besides the dashboard; each opens its own setup page in a new tab. */
const TOOLS: ReadonlyArray<Tool> = [
	{
		icon: "GithubIcon",
		name: "GitHub",
		line: "Deploy markers on every chart, and reviews of pull requests against production traces.",
		action: "Connect",
		href: hrefOf(AppRoute.SourcesNew({ search: { integration: "github" } })),
	},
	{
		icon: "SlackIcon",
		name: "Slack",
		line: "Alerts and incident updates in a channel, with the trace one click away.",
		action: "Add to Slack",
		href: hrefOf(AppRoute.Integrations({ search: { integration: "chat-slack" } })),
	},
	{
		icon: "ClaudeIcon",
		name: "Maple in your editor",
		line: "Ask Claude, Codex or Cursor about production while you code.",
		action: "Set up",
		href: hrefOf(AppRoute.Mcp()),
	},
]

const toolRow = (h: H, tool: Tool): Html =>
	h.li(
		[h.Class("flex flex-wrap items-center gap-x-3.5 gap-y-3 px-4 py-4")],
		[
			h.span(
				[
					h.AriaHidden(true),
					h.Class(
						"flex size-10 shrink-0 items-center justify-center rounded-md border border-border",
					),
				],
				[icon(h, tool.icon, { size: 20 })],
			),
			h.div(
				[h.Class("flex min-w-0 flex-1 basis-48 flex-col gap-1")],
				[
					h.span([h.Class("text-sm font-medium")], [tool.name]),
					h.span([h.Class("text-xs leading-snug text-muted-foreground")], [tool.line]),
				],
			),
			linkButton(
				h,
				{
					href: tool.href,
					variant: "outline",
					size: "sm",
					className: "max-sm:ml-13.5",
					attributes: [
						h.Target("_blank"),
						h.Rel("noopener"),
						h.AriaLabel(`${tool.action}: ${tool.name} (opens a new tab)`),
					],
				},
				[tool.action, icon(h, "ExternalLinkIcon", { size: 12 })],
			),
		],
	)

/** `StepTeam`: the tools Maple plugs into, then teammates. Every part is optional. */
export const teamStep = (h: H, team: Team): Html => {
	const isBusy = team.pending !== null
	return h.div(
		[h.Class(STEP_BODY_CLASS)],
		[
			h.div(
				[h.Class("flex flex-col gap-2.5")],
				[
					heading(h, { level: 1, variant: "display" }, ["Bring in your team and tools"]),
					h.p(
						[h.Class("text-title leading-relaxed text-muted-foreground")],
						["Maple shows up where you already work. Every one of these is optional."],
					),
				],
			),
			// Wrapped, so the column's side padding lands outside the list's border, not inside it.
			h.div(
				[],
				[
					h.ul(
						[
							h.AriaLabel("Tools"),
							h.Class(
								"flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border bg-card",
							),
						],
						TOOLS.map((tool) => toolRow(h, tool)),
					),
				],
			),
			team.isLoaded
				? h.div(
						[h.Class("flex flex-col gap-4")],
						[
							...(team.unavailableReason === null
								? []
								: [
										h.p(
											[h.Class("text-sm text-muted-foreground")],
											[team.unavailableReason],
										),
									]),
							inviteForm(h, team, isBusy),
							...invitedList(h, team.invited),
							h.div(
								[h.AriaLive("polite"), h.AriaAtomic(true), h.Class("min-h-5 text-xs")],
								[
									h.p(
										[
											h.Class(
												team.feedback?.isError === true
													? TONE_TEXT.crit
													: "text-muted-foreground",
											),
										],
										team.feedback === null ? [] : [team.feedback.message],
									),
								],
							),
						],
					)
				: h.output([h.Class("text-sm text-muted-foreground")], ["Loading your team…"]),
			h.div(
				[h.Class(cn(STEP_FOOTER_CLASS, "justify-between"))],
				[
					button(
						h,
						{
							variant: "ghost",
							isDisabled: isBusy,
							attributes: [h.OnClick(Message.ClickedBack({ to: "connect" }))],
						},
						[icon(h, "ArrowLeftIcon"), "Back"],
					),
					button(
						h,
						{
							size: "lg",
							isDisabled: isBusy,
							attributes: [h.OnClick(Message.ClickedContinue({ step: "team" }))],
						},
						["Continue", icon(h, "ArrowRightIcon", { size: 16 })],
					),
				],
			),
		],
	)
}

type Surface = Readonly<{ icon: IconName; where: string; title: string; body: string }>

/** Illustrations of what each tool looks like once connected; none of it is the org's data. */
const SURFACES: ReadonlyArray<Surface> = [
	{
		icon: "SlackIcon",
		where: "#alerts",
		title: "checkout-api p95 latency is 1.2s, over 800ms",
		body: "Started 4 min after deploy 3f9a1c2. Slowest span: db.query orders.",
	},
	{
		icon: "GithubIcon",
		where: "Pull request review",
		title: "maple reviewed this pull request",
		body: "getOrders runs 14k times an hour in production. This change removes an N+1 that accounts for 61% of its time.",
	},
	{
		icon: "ClaudeIcon",
		where: "Claude Code",
		title: "> why did signups drop this morning?",
		body: "POST /signup started returning 502 at 09:12. 214 errors, all one issue: TimeoutError in sendWelcomeEmail.",
	},
]

/** `TeamPreview`: where Maple shows up, as examples. */
export const teamPreview = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-3.5")],
		[
			h.div(
				[h.Class("mb-1 flex flex-col gap-1")],
				[
					eyebrow(h, { variant: "label" }, ["Where Maple shows up"]),
					h.span([h.Class("font-display text-xl font-semibold")], ["Right where the work happens"]),
				],
			),
			...SURFACES.map((surface) =>
				h.div(
					[h.Class("flex flex-col gap-2.5 rounded-md border border-border bg-background p-3.5")],
					[
						h.div(
							[h.Class("flex items-center gap-2 text-xs text-muted-foreground")],
							[icon(h, surface.icon, { size: 14 }), surface.where],
						),
						h.span([h.Class("text-ui font-medium")], [surface.title]),
						h.span([h.Class("text-xs leading-snug text-muted-foreground")], [surface.body]),
					],
				),
			),
			h.span([h.Class("text-2xs text-muted-foreground")], ["Examples of what each one looks like."]),
		],
	)

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

/** `StepPlan` / `StepPlanLayout`: the trial pitch over the pricing cards; it is the first step, so no Back. */
export const planStep = (h: H, isCustomerLoading: boolean, pricing: Html): Html =>
	h.div(
		[h.Class("flex flex-1 flex-col items-center px-6 pb-12 pt-4 sm:px-12 lg:px-16")],
		[
			h.div(
				[h.Class("w-full max-w-5xl")],
				[
					h.div(
						[h.Class("mb-10 flex flex-col items-center gap-2.5 text-center")],
						[
							heading(
								h,
								{ level: 1, variant: "display" },
								[`Start your ${TRIAL_DURATION_DAYS}-day free trial`],
							),
							h.p(
								[h.Class("max-w-lg text-title leading-relaxed text-muted-foreground")],
								[
									`Pick a plan to keep going. Your card is saved now and charged on day ${TRIAL_DURATION_DAYS}; cancel anytime from settings.`,
								],
							),
						],
					),
					isCustomerLoading ? pricingSkeleton(h) : pricing,
				],
			),
		],
	)

const inviteForm = (h: H, team: Team, isBusy: boolean): Html =>
	h.form(
		[h.Class("space-y-3"), h.OnSubmit(toTeam(TeamMessage.SubmittedInvite()))],
		[
			label(h, { attributes: [h.For("onboarding-teammate-email")] }, ["Invite a teammate"]),
			h.div(
				[h.Class("flex flex-wrap gap-2")],
				[
					input(h, {
						id: "onboarding-teammate-email",
						type: "email",
						className: "min-w-56 flex-1",
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
							isDisabled:
								!team.canManage ||
								isBusy ||
								team.email.trim() === "" ||
								isAlreadyInvited(team),
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
						: "They get an email invitation to join as a member.",
				],
			),
		],
	)
