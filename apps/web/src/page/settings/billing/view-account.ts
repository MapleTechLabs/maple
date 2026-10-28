import type { BillingAccount, BillingAccountOrg, BillingAccountOrgUsage } from "@maple/domain/http"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { initialsFrom } from "@maple/ui/lib/initials"
import { cn } from "@maple/ui/lib/utils"
import { formatCount, formatUsage } from "../../../lib/billing/usage"
import { formatDateInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { warmAvatarTone } from "../../../ui/avatar-tone"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { avatarFallback } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { nativeOption, nativeSelect } from "../../../ui/native-select"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { settingsSection } from "../kit/section"
import { Message, type Model } from "./model"
import { linkTargetOf } from "./update"

type H = HtmlBuilder<Message>

// Billing orgs: a member org's panel, the billing org's member list, and linking a standalone org.

const nameOf = (org: Readonly<{ name: string | null }>): string =>
	org.name === null || org.name.trim() === "" ? "Unnamed organization" : org.name

/** `OrgAvatar`: the org's logo over its initials on a warm tile keyed by the name. */
const orgAvatar = (h: H, name: string, imageUrl: string | null, className = "size-8"): Html =>
	avatarFallback(
		h,
		{
			className: cn("shrink-0 rounded-md bg-transparent", className),
			fallbackClassName: cn("rounded-[inherit] text-xs font-semibold", warmAvatarTone(name)),
			imageUrl: imageUrl ?? "",
			imageLabel: name,
			imageClassName: "object-cover",
		},
		initialsFrom(name),
	)

const prose = (h: H, children: ReadonlyArray<Html | string>, className?: string): Html =>
	h.p([h.Class(cn("font-prose text-sm text-muted-foreground", className))], children)

// MEMBER

/** A member org: who pays for it, and (admins) the way out. Plan, caps and invoices live there. */
export const memberSection = (h: H, model: Model, account: BillingAccount): Html => {
	const payer = nameOf(account.billingOrg)
	return settingsSection(h, { id: "settings-billing-account", title: "Billing account", padded: false }, [
		h.div(
			[h.Class("flex flex-wrap items-start gap-4 p-4")],
			[
				orgAvatar(h, payer, account.billingOrg.imageUrl, "size-10"),
				h.div(
					[h.Class("flex min-w-0 flex-1 flex-col gap-1")],
					[
						h.p([h.Class("text-sm font-medium")], [`Billed through ${payer}`]),
						prose(h, [
							`This organization's usage counts toward ${payer}'s plan and appears on its invoice. Plan, payment and invoices are managed in ${payer}.`,
						]),
					],
				),
				...(model.isAdmin
					? [
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									attributes: [h.OnClick(Message.ClickedUnlink({ orgId: account.orgId }))],
								},
								[`Stop billing through ${payer}`],
							),
						]
					: []),
			],
		),
	])
}

// BILLING ORG

/** One org's volume, compact: bytes across signals, then sessions and events when there are any. */
const volumeLabel = (usage: BillingAccountOrgUsage): string =>
	[
		formatUsage(usage.logsGB + usage.tracesGB + usage.metricsGB),
		...(usage.browserSessions > 0 ? [`${formatCount(usage.browserSessions)} sessions`] : []),
		...(usage.productEvents > 0 ? [`${formatCount(usage.productEvents)} events`] : []),
	].join(" · ")

const volumeCell = (h: H, model: Model, member: BillingAccountOrg): Html =>
	AsyncData.matchDataSplitEmpty(model.accountUsage, {
		onIdle: () => skeleton(h, "h-3.5 w-20"),
		onLoading: () => skeleton(h, "h-3.5 w-20"),
		onFailure: () => h.span([h.Class("text-sm text-muted-foreground")], [EMPTY_VALUE]),
		onData: (usage) => {
			const row = usage.orgs.find((org) => org.orgId === member.orgId)
			return h.span(
				[h.Class("font-mono text-sm tabular-nums")],
				[row === undefined ? EMPTY_VALUE : volumeLabel(row)],
			)
		},
	})

const memberRow = (h: H, model: Model, member: BillingAccountOrg, timeZone: string): Html => {
	const name = nameOf(member)
	return h.div(
		[
			h.Key(member.orgId),
			h.Class("flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3"),
		],
		[
			h.div(
				[h.Class("flex min-w-0 items-center gap-3")],
				[
					orgAvatar(h, name, member.imageUrl),
					h.div(
						[h.Class("flex min-w-0 flex-col gap-0.5")],
						[
							h.span([h.Class("truncate text-sm font-medium")], [name]),
							h.span(
								[h.Class("text-2xs text-muted-foreground")],
								[
									member.linkedAt === undefined
										? "Billed here"
										: `Billed here since ${formatDateInTimezone(member.linkedAt, { timeZone })}`,
								],
							),
						],
					),
				],
			),
			h.div(
				[h.Class("flex items-center gap-4")],
				[
					volumeCell(h, model, member),
					...(model.isAdmin
						? [
								button(
									h,
									{
										variant: "ghost",
										size: "sm",
										attributes: [
											h.AriaLabel(`Remove ${name} from billing`),
											h.OnClick(Message.ClickedUnlink({ orgId: member.orgId })),
										],
									},
									["Remove"],
								),
							]
						: []),
				],
			),
		],
	)
}

/** The orgs this one pays for, with what each sent this cycle. */
export const billedOrgsSection = (h: H, model: Model, account: BillingAccount, timeZone: string): Html =>
	settingsSection(
		h,
		{
			id: "settings-billing-members",
			title: "Billed organizations",
			description: [
				"These organizations keep their own data. Their usage counts toward this plan and appears on this organization's invoice. Volume is for the current cycle.",
			],
			framed: false,
		},
		[
			panel(
				h,
				{ className: "divide-y divide-border/60" },
				account.members.map((member) => memberRow(h, model, member, timeZone)),
			),
			...(AsyncData.isFailure(model.accountUsage)
				? [
						errorState(h, {
							variant: "row",
							failure: model.accountUsage.error,
							title: "Couldn't load each organization's usage",
							onRetry: Message.ClickedRetryAccountUsage(),
						}),
					]
				: []),
		],
	)

// STANDALONE

/** An admin's other orgs to bill this one through; hidden until there is at least one. */
export const linkSection = (h: H, model: Model): ReadonlyArray<Html> => {
	const choices = AsyncData.getOrElse(model.orgChoices, () => [])
	const target = linkTargetOf(model)
	if (target === null) return []
	return [
		settingsSection(
			h,
			{
				id: "settings-billing-link",
				title: "Bill through another organization",
				description: [
					"Move this organization's billing to another organization you administer: one plan, one usage pool and one invoice. Data stays separate.",
				],
			},
			[
				h.div(
					[h.Class("flex flex-wrap items-center gap-3")],
					[
						nativeSelect(
							h,
							{
								className: "w-64 max-w-full [&>select]:text-sm",
								defaultValue: target.orgId,
								isDisabled: model.isLinking,
								attributes: [
									h.AriaLabel("Organization to bill through"),
									h.OnChange((value) => Message.ChangedLinkOrg({ value })),
								],
							},
							choices.map((choice) => nativeOption(choice.orgId, choice.name)),
						),
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								isDisabled: model.isLinking,
								attributes: [h.OnClick(Message.ClickedLink())],
							},
							[`Bill through ${target.name}`],
						),
					],
				),
				...(model.linkRejection === null
					? []
					: [
							h.p(
								[h.Class("mt-3 font-prose text-sm text-destructive"), h.Role("alert")],
								[model.linkRejection],
							),
						]),
			],
		),
	]
}

// DIALOGS

export const accountDialogs = (h: H, model: Model, account: BillingAccount | null): ReadonlyArray<Html> => {
	const target = linkTargetOf(model)
	const removing =
		account === null || model.unlinkOrgId === null
			? null
			: account.role === "member"
				? null
				: (account.members.find((member) => member.orgId === model.unlinkOrgId) ?? null)
	const payer = account === null ? "" : nameOf(account.billingOrg)
	return [
		confirmDialog(h, {
			slotId: "billing-link",
			model: model.linkDialog,
			toParentMessage: (message) => Message.GotLinkDialogMessage({ message }),
			tone: "default",
			hasIcon: false,
			title: `Bill this organization through ${target?.name ?? "another organization"}?`,
			description: [
				`From now on, this organization's usage counts toward ${target?.name ?? "that organization"}'s plan and appears on its invoice. If this organization has its own plan, it is cancelled at the end of its current period. Its data stays where it is.`,
			],
			confirmLabel: `Bill through ${target?.name ?? "it"}`,
			isPending: model.isLinking,
			onConfirm: Message.ClickedConfirmLink(),
		}),
		confirmDialog(h, {
			slotId: "billing-unlink",
			model: model.unlinkDialog,
			toParentMessage: (message) => Message.GotUnlinkDialogMessage({ message }),
			...(removing === null
				? {
						title: `Stop billing through ${payer}?`,
						description: `This organization's usage stops counting toward ${payer}'s plan. It will then need its own plan.`,
						confirmLabel: `Stop billing through ${payer}`,
					}
				: {
						title: `Remove ${nameOf(removing)}?`,
						description: `${nameOf(removing)} stops being billed through this organization. Its usage from now on leaves this invoice, and it will need its own plan.`,
						confirmLabel: "Remove",
					}),
			isPending: model.isUnlinking,
			onConfirm: Message.ClickedConfirmUnlink(),
		}),
	]
}
