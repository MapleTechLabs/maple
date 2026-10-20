import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { copyableField } from "../../../ui/copyable-field"
import * as DialogView from "../../../ui/dialog-view"
import { icon, type IconName } from "../../../ui/icon"
import * as RadioGroup from "../../../ui/radio-group"
import { SHAREABLE_WIDGET_KINDS, unsupportedShareWidgets } from "../kit/share-support"
import { Message } from "./message"
import type { Model } from "./model"
import { type Access, boardShareOf, ShareMessage, shareUrl } from "./share"

// `ShareDashboardDialog` and `ShareLinkRow`: the share dialog and one link's row.

type H = HtmlBuilder<Message>

const wrap = (message: ShareMessage) => Message.GotShareMessage({ message })

const ACCESS: ReadonlyArray<Readonly<{ value: Access; icon: IconName; title: string; body: string }>> = [
	{ value: "off", icon: "LockIcon", title: "Not shared", body: "Only members of this organization with access to Maple can see it." },
	{ value: "org", icon: "ShieldIcon", title: "Anyone in this organization", body: "Signed-in members of this organization can open the link." },
	{
		value: "public",
		icon: "GlobeIcon",
		title: "Anyone with the link",
		body: "No sign-in required. Anyone who has the link can view this dashboard and its data.",
	},
]

/** `NoticeRow`: a muted (or error) line with the warning glyph. */
export const noticeRow = (h: H, tone: "muted" | "error", children: ReadonlyArray<Html | string>): Html =>
	h.div(
		[h.Class(cn("flex items-start gap-2 text-xs leading-relaxed", tone === "error" ? TONE_TEXT.crit : "text-muted-foreground"))],
		[icon(h, "CircleWarningIcon", { size: 13, className: "mt-0.5 shrink-0" }), h.p([h.Class("min-w-0")], children)],
	)

/** `ShareLinkRow`: the copyable link, and Replace behind a confirmation. */
export const shareLinkRow = (h: H, model: Model, url: string, replaceWarning: string): ReadonlyArray<Html> => [
	h.div(
		[h.Class("flex items-center gap-2")],
		[
			h.div(
				[h.Class("min-w-0 flex-1")],
				[
					copyableField(h, {
						id: "dashboard-share-link",
						value: url,
						copyLabel: "Share link",
						copy: model.sharing.linkCopy,
						toCopyMessage: (message) => wrap(ShareMessage.GotLinkCopyMessage({ message })),
					}),
				],
			),
			button(h, { size: "sm", variant: "outline", attributes: [h.OnClick(wrap(ShareMessage.ClickedReplace()))] }, [
				icon(h, "ArrowRotateClockwiseIcon"),
				"Replace",
			]),
		],
	),
	confirmDialog(h, {
		slotId: "dashboard-share-replace",
		model: model.sharing.replaceDialog,
		toParentMessage: (message) => wrap(ShareMessage.GotReplaceDialogMessage({ message })),
		title: "Replace this link?",
		description: `${replaceWarning} This can't be undone.`,
		confirmLabel: "Replace link",
		isNested: true,
		onConfirm: wrap(ShareMessage.ConfirmedReplace()),
	}),
]

const accessOption = (h: H, config: RadioGroup.RadioGroupViewConfig<Message>, option: (typeof ACCESS)[number]): Html =>
	h.label(
		[
			h.For(`share-${option.value}`),
			h.Id(`share-${option.value}-label`),
			h.Class(
				"group flex cursor-pointer items-start gap-3 px-3.5 py-3 transition-colors hover:bg-accent/40 has-[[data-checked]]:bg-accent/64",
			),
		],
		[
			icon(h, option.icon, {
				size: 15,
				className: "mt-0.5 shrink-0 text-muted-foreground transition-colors group-has-[[data-checked]]:text-primary",
			}),
			h.div(
				[h.Class("min-w-0 flex-1 space-y-0.5")],
				[
					h.div([h.Class("font-medium text-sm leading-5")], [option.title]),
					h.p([h.Class("text-muted-foreground text-xs leading-relaxed")], [option.body]),
				],
			),
			...RadioGroup.radio(h, config, option.value, "mt-0.5 shrink-0"),
		],
	)

const panelContent = (h: H, model: Model): ReadonlyArray<Html> => {
	const shares = AsyncData.getOrElse(model.sharing.shares, () => [])
	const boardShare = boardShareOf(shares)
	const serverAccess: Access = boardShare?.mode ?? "off"
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: RadioGroup.init(model.sharing.pendingAccess ?? serverAccess),
		toParentMessage: (message) => wrap(ShareMessage.GotAccessMessage({ message })),
		items: ACCESS.map((option) => ({ value: option.value, id: `share-${option.value}-radio`, inputId: `share-${option.value}` })),
	}
	const unsupported = unsupportedShareWidgets(model.document?.widgets ?? [])
	return [
		RadioGroup.radioGroup(
			h,
			{ className: "gap-0 divide-y divide-border overflow-hidden rounded-md border" },
			ACCESS.map((option) => accessOption(h, config, option)),
		),
		...(boardShare === undefined
			? []
			: shareLinkRow(
					h,
					model,
					shareUrl(model.sharing.origin, boardShare.token),
					"Anyone using the current link loses access to this dashboard. Chart embeds keep working.",
				)),
		...(unsupported.length > 0 && boardShare !== undefined
			? [
					noticeRow(h, "muted", [
						unsupported.length === 1 ? "1 widget won't render for viewers" : `${unsupported.length} widgets won't render for viewers`,
						": ",
						unsupported.map((widget) => widget.title).join(", "),
						". Shared views support",
						" ",
						SHAREABLE_WIDGET_KINDS,
						".",
					]),
				]
			: []),
		...(model.sharing.error === null ? [] : [noticeRow(h, "error", [model.sharing.error])]),
	]
}

export const shareDialog = (h: H, model: Model): Html => {
	const id = model.sharing.dialog.id
	return h.submodel({
		slotId: "dashboard-share-dialog",
		model: model.sharing.dialog,
		view: DialogView.view,
		toParentMessage: (message) => wrap(ShareMessage.GotDialogMessage({ message })),
		viewInputs: {
			hasTrigger: false,
			hasDescription: true,
			className: "sm:max-w-lg",
			nestedDialogs: model.sharing.replaceDialog.isOpen ? 1 : 0,
			toView: ({ portal }) => portal,
			toContent: (close) => [
				DialogView.dialogHeader(h, "dialog", [
					DialogView.dialogTitle(h, "dialog", id, "Share dashboard"),
					DialogView.dialogDescription(h, "dialog", id, "Anyone you share with sees this dashboard's data, but cannot edit it."),
				]),
				DialogView.dialogPanel(h, "dialog", id, panelContent(h, model), "space-y-4"),
				DialogView.dialogFooter(h, "dialog", [button(h, { variant: "outline", attributes: close }, ["Done"])]),
			],
		},
	})
}
