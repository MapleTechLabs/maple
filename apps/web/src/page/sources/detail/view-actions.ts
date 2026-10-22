import type { V2Source } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { type ConfirmDialogOptions, confirmDialog } from "../../../ui/confirm-dialog"
import { icon } from "../../../ui/icon"
import * as MenuView from "../../../ui/menu-view"
import { deleteConsequences } from "../kit/integration"
import { integrationPlatformOf } from "../kit/shared"
import { Message } from "./message"
import type { Model } from "./model"
import { PAUSE_CHOICES, PAUSE_MENU_ID } from "./update"

// `SourceActions`, `IntegrationActions` and `PauseMenu`.

type H = HtmlBuilder<Message>

const inlineIcon = (h: H, name: "MediaPauseIcon" | "MediaPlayIcon" | "ArrowPathIcon" | "TrashIcon") =>
	icon(h, name, { attributes: [h.DataAttribute("icon", "inline-start")] })

const isIntegration = (source: V2Source) => integrationPlatformOf(source) !== null

const pauseMenu = (h: H, model: Model, source: V2Source): Html =>
	h.submodel({
		slotId: PAUSE_MENU_ID,
		model: model.pauseMenu,
		view: MenuView.view,
		toParentMessage: (message) => Message.GotPauseMenuMessage({ message }),
		viewInputs: {
			align: "end",
			className: "w-72",
			entries: [
				{
					_tag: "Content",
					content: h.div(
						[h.Class("space-y-1 px-2 pt-1.5 pb-2")],
						[
							h.p([h.Class("text-xs font-medium")], ["Pause ingestion"]),
							h.p(
								[h.Class("text-muted-foreground text-xs leading-relaxed")],
								[
									isIntegration(source)
										? "Maple keeps collecting, but what it collects is dropped, not stored or billed."
										: "Senders keep getting 200 OK. Data is dropped, not stored or billed.",
								],
							),
						],
					),
				},
				{ _tag: "Separator" },
				{
					_tag: "Group",
					entries: PAUSE_CHOICES.map((choice): MenuView.MenuItemEntry => ({
						_tag: "Item",
						value: choice.value,
						label: choice.label,
					})),
				},
			],
			toView: ({ trigger, withTrigger }) =>
				h.span(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								isLoading: model.busy === "pause",
								isDisabled: source.status === "expired",
								attributes: [...trigger],
							},
							[inlineIcon(h, "MediaPauseIcon"), "Pause"],
						),
					),
				),
		},
	})

const name = (h: H, source: V2Source) => h.span([h.Class("text-foreground font-medium")], [source.name])

/** Resume while paused, the pause menu otherwise. Every source but the default one pauses. */
export const pauseControl = (h: H, model: Model, source: V2Source): Html =>
	source.status === "paused"
		? button(
				h,
				{
					variant: "outline",
					size: "sm",
					isLoading: model.busy === "resume",
					attributes: [h.OnClick(Message.ClickedResume())],
				},
				[inlineIcon(h, "MediaPlayIcon"), "Resume"],
			)
		: pauseMenu(h, model, source)

const deleteButton = (h: H) =>
	button(
		h,
		{
			variant: "ghost",
			size: "sm",
			className: "text-destructive",
			attributes: [h.OnClick(Message.ClickedDelete())],
		},
		[inlineIcon(h, "TrashIcon"), "Delete"],
	)

/** A token source's delete: its senders are refused. */
const tokenDeleteDialog = (h: H, model: Model, source: V2Source): Html =>
	confirmDialog(h, {
		slotId: "source-delete-confirm",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: "Delete source?",
		description: [
			"Senders using ",
			name(h, source),
			" are rejected within a minute. This cannot be undone.",
		],
		confirmLabel: "Delete",
		onConfirm: Message.ConfirmedDelete(),
		isPending: model.busy === "delete",
	})

/** An integration source's delete disconnects its integration; pausing is the reversible choice. */
const integrationDeleteDialog = (h: H, model: Model, source: V2Source): Html => {
	const options: ConfirmDialogOptions<Message> = {
		slotId: "source-delete-confirm",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: ["Delete ", name(h, source), "?"],
		description: "This disconnects the integration. To stop it for a while instead, pause it.",
		children: [
			h.ul(
				[h.Class("bg-muted flex flex-col gap-1.5 rounded-lg p-3 text-xs")],
				deleteConsequences(source).map((line) => h.keyed("li")(line, [], [line])),
			),
		],
		confirmLabel: "Disconnect and delete",
		onConfirm: Message.ConfirmedDelete(),
		isPending: model.busy === "delete",
	}
	// A paused source has nothing to pause instead.
	return confirmDialog(
		h,
		source.status === "paused"
			? options
			: {
					...options,
					secondaryAction: { label: "Pause instead", onClick: Message.ClickedPauseUntilResumed() },
				},
	)
}

/** Pause or Resume, Roll token and Delete: a token source's actions. */
export const sourceActions = (h: H, model: Model, source: V2Source): ReadonlyArray<Html> => [
	pauseControl(h, model, source),
	button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedRollToken())] }, [
		inlineIcon(h, "ArrowPathIcon"),
		"Roll token",
	]),
	deleteButton(h),
	confirmDialog(h, {
		slotId: "source-roll-confirm",
		model: model.rollDialog,
		toParentMessage: (message) => Message.GotRollDialogMessage({ message }),
		title: "Roll this source's token?",
		description: [
			name(h, source),
			" gets a new token and keeps its settings. Senders using the old token are rejected within a minute.",
		],
		confirmLabel: "Roll token",
		onConfirm: Message.ConfirmedRoll(),
		isPending: model.busy === "roll",
	}),
	tokenDeleteDialog(h, model, source),
]

/** Pause or Resume, the integration's own actions (`connection`), and Delete. */
export const integrationActions = (
	h: H,
	model: Model,
	source: V2Source,
	connection: Html | null,
): ReadonlyArray<Html> => [
	pauseControl(h, model, source),
	...(connection === null ? [] : [connection]),
	deleteButton(h),
	// Google Cloud's Delete opens the integration's removal dialog (rendered with `connection`) while its connector exists.
	integrationDeleteDialog(h, model, source),
]
