import { MapleRegion } from "@maple/domain/organization-regions"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { hasMultipleRegions } from "../../lib/region"
import type { ClerkOrganization, UserInvitation } from "../../platform/clerk"
import { switchTargetOf } from "../../shell/clerk-org-switcher"
import { button } from "../../ui/button"
import { icon, type IconName } from "../../ui/icon"
import { input } from "../../ui/input"
import { Message, type Model, MountDitherField } from "./create-org"
import { optionCard } from "./option-card"
import { REGION_CARDS } from "./quick-start-region-view"
import { regionFlag } from "./region-flag"

// The `/org-required` screen: the form on the left, a preview of the workspace being made on the right.

type H = HtmlBuilder<Message>

/** The name as typed, or what an untitled org is called until it has one. */
const nameOf = (name: string): string => name.trim() || "your organization"

/** The org's initial, as its avatar tile and the preview's switcher show it. */
const initialOf = (name: string): string => nameOf(name).charAt(0).toUpperCase()

const header = (h: H, email: string | null): Html =>
	h.div(
		[h.Class("flex items-center justify-between gap-4")],
		[
			h.div(
				[h.Class("flex items-center gap-2 text-foreground")],
				[
					h.span(
						[h.Class("text-primary"), h.AriaHidden(true)],
						[icon(h, "MapleMark", { size: 20 })],
					),
					h.span([h.Class("font-display text-lg font-semibold tracking-tight")], ["maple"]),
				],
			),
			h.div(
				[h.Class("flex min-w-0 items-center gap-3 text-xs")],
				[
					...(email === null ? [] : [h.span([h.Class("truncate text-muted-foreground")], [email])]),
					h.button(
						[
							h.Type("button"),
							h.Class("shrink-0 text-foreground underline-offset-4 hover:underline"),
							h.OnClick(Message.ClickedSignOut()),
						],
						["Sign out"],
					),
				],
			),
		],
	)

const nameField = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex flex-col gap-2.5")],
		[
			h.label(
				[h.For("org-required-name"), h.Class("text-sm font-medium")],
				["What should we call it?"],
			),
			h.div(
				[h.Class("flex items-center gap-3")],
				[
					h.span(
						[
							h.AriaHidden(true),
							h.Class(
								"flex size-12 shrink-0 items-center justify-center rounded-lg bg-primary font-display text-xl font-semibold text-primary-foreground",
							),
						],
						[initialOf(model.name)],
					),
					input(h, {
						id: "org-required-name",
						size: "lg",
						className: "flex-1",
						controlClassName: "h-12 text-base",
						isDisabled: model.isCreating || model.createdOrgId !== null,
						attributes: [
							h.Maxlength(100),
							h.Placeholder("Organization name"),
							h.Required(true),
							h.Autocomplete("organization"),
							h.Value(model.name),
							h.OnInput((value) => Message.ChangedName({ value })),
						],
					}),
				],
			),
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				[
					model.suggestedFrom === null
						? "You can rename it whenever you like."
						: `We guessed from ${model.suggestedFrom}. Rename it whenever you like.`,
				],
			),
		],
	)

const regionField = (h: H, model: Model): Html =>
	h.fieldset(
		[h.Class("flex min-w-0 flex-col gap-2.5")],
		[
			h.legend([h.Class("mb-2.5 text-sm font-medium")], ["Where should your data live?"]),
			h.div(
				[h.Class("grid gap-3 sm:grid-cols-2")],
				MapleRegion.literals.map((region) =>
					optionCard(h, {
						type: "radio",
						name: "org-required-region",
						layout: "stacked",
						isChecked: model.region === region,
						isDisabled: model.isCreating || model.createdOrgId !== null,
						onChange: Message.PickedRegion({ region }),
						label: REGION_CARDS[region].name,
						title: REGION_CARDS[region].name,
						description: REGION_CARDS[region].residency,
						media: regionFlag(h, region, "h-7 w-[42px]"),
					}),
				),
			),
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				["Pick once: the region can't be changed later."],
			),
		],
	)

type OrgRowOptions = Readonly<{
	name: string
	imageUrl: string
	lead: string
	action: string
	actionLabel: string
	isLoading: boolean
	isDisabled: boolean
	onClick: Message
}>

/** An org the user can go to instead of creating one: an invitation, or one they already belong to. */
const orgRow = (h: H, options: OrgRowOptions): Html =>
	h.div(
		[h.Class("flex items-center gap-3 rounded-md border border-dashed border-input px-3.5 py-3")],
		[
			options.imageUrl === ""
				? h.span(
						[
							h.AriaHidden(true),
							h.Class(
								"flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold",
							),
						],
						[initialOf(options.name)],
					)
				: h.img([
						h.Src(options.imageUrl),
						h.Alt(""),
						h.Class("size-7 shrink-0 rounded-md object-cover"),
					]),
			h.span(
				[h.Class("min-w-0 flex-1 text-sm leading-snug text-muted-foreground line-clamp-2")],
				[options.lead, " ", h.span([h.Class("font-medium text-foreground")], [options.name])],
			),
			button(
				h,
				{
					variant: "ghost",
					size: "sm",
					className: "text-primary",
					isLoading: options.isLoading,
					isDisabled: options.isDisabled,
					attributes: [h.OnClick(options.onClick), h.AriaLabel(options.actionLabel)],
				},
				[options.action],
			),
		],
	)

const isBusy = (model: Model): boolean =>
	model.isCreating || model.joiningId !== null || model.openingId !== null

const invitationRow = (h: H, model: Model, invitation: UserInvitation): Html =>
	orgRow(h, {
		name: invitation.orgName,
		imageUrl: invitation.imageUrl,
		lead: "You're invited to",
		action: "Join instead",
		actionLabel: `Join ${invitation.orgName}`,
		isLoading: model.joiningId === invitation.id,
		isDisabled: isBusy(model) && model.joiningId !== invitation.id,
		onClick: Message.ClickedJoin({ invitationId: invitation.id }),
	})

const membershipRow = (h: H, model: Model, organization: ClerkOrganization): Html =>
	orgRow(h, {
		name: organization.name,
		imageUrl: organization.imageUrl,
		lead: "You're a member of",
		action: "Open",
		actionLabel: `Open ${organization.name}`,
		isLoading: model.openingId === organization.id,
		isDisabled: isBusy(model) && model.openingId !== organization.id,
		onClick: Message.ClickedOpen({ orgId: organization.id, targetUrl: switchTargetOf(organization) }),
	})

const form = (h: H, model: Model, memberships: ReadonlyArray<ClerkOrganization>): Html =>
	h.form(
		[
			h.Class("flex flex-col gap-9"),
			h.AriaLabel("Create your organization"),
			h.OnSubmit(Message.SubmittedCreate()),
		],
		[
			nameField(h, model),
			...(hasMultipleRegions ? [regionField(h, model)] : []),
			h.div(
				[h.Class("flex flex-col gap-4")],
				[
					h.p(
						[h.AriaLive("polite"), h.Class(cn("min-h-4 text-xs", TONE_TEXT.crit))],
						model.errorMessage === null ? [] : [model.errorMessage],
					),
					button(
						h,
						{
							type: "submit",
							size: "lg",
							className: "h-12 w-full text-title font-semibold",
							isLoading: model.isCreating,
							isDisabled:
								model.name.trim() === "" ||
								model.joiningId !== null ||
								model.openingId !== null,
						},
						[
							`${model.createdOrgId === null ? "Create" : "Open"} ${nameOf(model.name)}`,
							icon(h, "ArrowRightIcon", { size: 16 }),
						],
					),
					...memberships.map((organization) => membershipRow(h, model, organization)),
					...(model.invitations ?? []).map((invitation) => invitationRow(h, model, invitation)),
					...(model.invitationsError === null
						? []
						: [
								h.p(
									[h.Class("text-xs text-muted-foreground")],
									[`Couldn't check whether anyone invited you: ${model.invitationsError}`],
								),
							]),
				],
			),
		],
	)

const NAV: ReadonlyArray<readonly [IconName, string]> = [
	["HouseIcon", "Overview"],
	["NetworkNodesIcon", "Services"],
	["PulseIcon", "Traces"],
	["FileIcon", "Logs"],
	["ChartLineIcon", "Metrics"],
	["BellIcon", "Alerts"],
]

/** A small, static copy of the dashboard the org will open on, its name and region as typed so far. */
const workspacePreview = (h: H, model: Model): Html =>
	h.div(
		[h.AriaHidden(true), h.Class("relative flex w-full max-w-[640px] flex-col items-center gap-5")],
		[
			h.span([h.Class("text-sm font-medium text-foreground")], ["A peek at your new workspace"]),
			h.div(
				[h.Class("w-full overflow-hidden rounded-md border border-border bg-background")],
				[
					h.div(
						[h.Class("flex h-9 items-center gap-1.5 border-b border-border bg-sidebar px-3.5")],
						[0, 1, 2].map(() => h.span([h.Class("size-2.5 rounded-full bg-input")], [])),
					),
					h.div(
						[h.Class("flex h-[420px]")],
						[
							h.div(
								[
									h.Class(
										"flex w-[200px] shrink-0 flex-col gap-4 border-r border-sidebar-border bg-sidebar p-3",
									),
								],
								[
									h.div(
										[
											h.Class(
												"flex items-center gap-2 rounded-md border border-primary bg-sidebar-accent p-1.5",
											),
										],
										[
											h.span(
												[
													h.Class(
														"flex size-6 shrink-0 items-center justify-center rounded-sm bg-primary text-xs font-semibold text-primary-foreground",
													),
												],
												[initialOf(model.name)],
											),
											h.span(
												[h.Class("min-w-0 flex-1 truncate text-ui font-medium")],
												[nameOf(model.name)],
											),
											...(hasMultipleRegions
												? [regionFlag(h, model.region, "h-2.5 w-[15px]")]
												: []),
										],
									),
									h.div(
										[h.Class("flex flex-col gap-0.5")],
										NAV.map(([iconName, label], index) =>
											h.div(
												[
													h.Class(
														cn(
															"flex h-7 items-center gap-2 rounded-md px-2 text-xs",
															index === 0
																? "bg-sidebar-accent text-foreground"
																: "text-muted-foreground",
														),
													),
												],
												[icon(h, iconName, { size: 14 }), label],
											),
										),
									),
								],
							),
							h.div(
								[h.Class("flex flex-1 flex-col gap-4 p-5")],
								[
									h.span(
										[h.Class("font-display text-title font-semibold")],
										[`Welcome to ${nameOf(model.name)}`],
									),
									h.div(
										[
											h.Class(
												"flex flex-1 flex-col items-center justify-center gap-2.5 rounded-md border border-dashed border-input",
											),
										],
										[
											h.span(
												[h.Class("text-primary")],
												[icon(h, "FrameworkOpenTelemetryIcon", { size: 28 })],
											),
											h.span(
												[h.Class("text-ui font-medium")],
												["Waiting for your first span"],
											),
											h.span(
												[h.Class("text-xs text-muted-foreground")],
												["Connect a service and it shows up here."],
											),
										],
									),
								],
							),
						],
					),
				],
			),
		],
	)

export const view = (
	h: H,
	model: Model,
	email: string | null,
	memberships: ReadonlyArray<ClerkOrganization>,
): Html =>
	h.main(
		// One screen high: the form column scrolls under its fixed header, the preview stays put.
		[h.Class("flex h-dvh overflow-hidden bg-background text-foreground")],
		[
			h.div(
				[h.Class("flex h-dvh w-full shrink-0 flex-col lg:w-[640px]")],
				[
					h.div([h.Class("shrink-0 px-6 pt-8 sm:px-12 lg:px-20 lg:pt-12")], [header(h, email)]),
					h.div(
						[
							h.Class(
								"min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-10 sm:px-12 lg:px-20",
							),
						],
						[
							h.div(
								[h.Class("flex flex-col gap-10 pt-12")],
								[
									h.div(
										[h.Class("flex flex-col gap-3")],
										[
											h.p([h.Class("text-sm text-primary")], ["Welcome to Maple"]),
											h.h1(
												[
													h.Class(
														"font-display text-4xl font-semibold leading-[1.1] tracking-tight",
													),
												],
												["Let's give your team a home."],
											),
											h.p(
												[
													h.Class(
														"max-w-md text-title leading-relaxed text-muted-foreground",
													),
												],
												[
													"Your traces, logs, dashboards and alerts all live in one organization. It takes ten seconds.",
												],
											),
										],
									),
									form(h, model, memberships),
								],
							),
						],
					),
				],
			),
			h.div(
				[h.Class("relative hidden h-dvh flex-1 border-l border-border bg-sidebar lg:block")],
				[
					h.div(
						[h.Class("pointer-events-none absolute inset-0 overflow-hidden")],
						[
							h.canvas(
								[
									h.Class("absolute left-0 top-0 size-full"),
									h.DataAttribute("reach", "0.55"),
									h.OnMount(MountDitherField()),
								],
								[],
							),
						],
					),
					h.div(
						[h.Class("absolute inset-0 flex flex-col overflow-y-auto p-14")],
						[
							h.div(
								[h.Class("m-auto flex w-full max-w-[640px] justify-center")],
								[workspacePreview(h, model)],
							),
						],
					),
				],
			),
		],
	)
