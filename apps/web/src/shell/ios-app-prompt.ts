import { IOS_APP_NAME, IOS_APP_STORE_URL } from "@maple/domain/mobile-app"
import { writeLocalStorage } from "@maple/ui/lib/local-storage"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import * as Popover from "@maple/views/ui/popover"
import { qrCode } from "@maple/views/ui/qr-code"
import { sidebarMenuButton, sidebarMenuItem } from "@maple/views/ui/sidebar"
import { vstack } from "@maple/views/ui/stack"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "./message"
import { IOS_PROMPT_POPOVER_ID, type Model, type ShellClerk } from "./model"

// The sidebar's nudge to install the iPhone app: one footer row. On a desktop it opens a popover
// with a QR code and Apple's badge; on a phone it is a link to the listing. Dismissed per user.

/** `maple.ios-app-prompt.dismissed.<userId>`: that user closed the card here. */
export const IOS_PROMPT_STORAGE_PREFIX = "maple.ios-app-prompt.dismissed."

export const SaveIosPromptDismissed = Command.define("SaveIosPromptDismissed", {
	args: { userId: Schema.String },
	messages: [Message.CompletedSaveIosPromptDismissed],
	execute: ({ userId }) =>
		Effect.sync(() => {
			writeLocalStorage(`${IOS_PROMPT_STORAGE_PREFIX}${userId}`, "1")
			return Message.CompletedSaveIosPromptDismissed()
		}),
})

/** The signed-in user the row is for: none self-hosted, before Clerk answers, or once they dismissed it. */
export const iosPromptUser = (model: Model, clerk: ShellClerk | null): Option.Option<string> =>
	Option.filter(
		clerk === null ? Option.none() : clerk.maybeUserId,
		(userId) => !Arr.contains(model.iosPromptDismissedUsers, userId),
	)

const ROW_LABEL = "Get the iPhone app"
const STORE_LABEL = "Download on the App Store"

const rowContent = (h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
	icon(h, "MobileIcon", { size: 18 }),
	h.span([], [ROW_LABEL]),
]

const storeBadge = (h: HtmlBuilder<Message>): Html =>
	h.a(
		[
			h.Href(IOS_APP_STORE_URL),
			h.Target("_blank"),
			h.Rel("noopener noreferrer"),
			h.AriaLabel(STORE_LABEL),
			h.Class("rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"),
		],
		[
			h.img([
				h.Src("/app-store-badge.svg"),
				h.Alt(""),
				h.Attribute("width", "120"),
				h.Attribute("height", "40"),
				h.Class("block h-10 w-auto"),
			]),
		],
	)

const panel = (h: HtmlBuilder<Message>, userId: string): ReadonlyArray<Html> => [
	vstack(h, { gap: "3", align: "center", className: "w-52 text-center" }, [
		qrCode(h, {
			value: IOS_APP_STORE_URL,
			label: `QR code to ${IOS_APP_NAME} on the App Store`,
			className: "size-36",
		}),
		Popover.popoverDescription(
			h,
			IOS_PROMPT_POPOVER_ID,
			"Scan with your iPhone to get critical alerts on your Lock Screen.",
		),
		storeBadge(h),
		button(
			h,
			{
				variant: "ghost",
				size: "sm",
				attributes: [h.OnClick(Message.ClickedDismissIosPrompt({ userId }))],
			},
			["Don't show again"],
		),
	]),
]

/** The footer row, or nothing; the collapsed rail has no room for a nudge. */
export const iosAppPrompt = (
	h: HtmlBuilder<Message>,
	model: Model,
	clerk: ShellClerk | null,
): ReadonlyArray<Html> =>
	Option.match(iosPromptUser(model, clerk), {
		onNone: () => [],
		onSome: (userId) => [
			sidebarMenuItem(h, "group-data-[collapsible=icon]:hidden", [
				// A phone is the device: the row goes straight to the listing, with no code to scan.
				model.isMobile
					? sidebarMenuButton(
							h,
							{
								href: IOS_APP_STORE_URL,
								attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
							},
							rowContent(h),
						)
					: h.submodel({
							slotId: IOS_PROMPT_POPOVER_ID,
							model: model.iosPromptPopover,
							view: Popover.view,
							viewInputs: {
								className: "w-auto",
								toContent: () => (model.iosPromptPopover.isOpen ? panel(h, userId) : []),
								toView: ({ trigger, withTrigger }) =>
									h.div(
										[],
										withTrigger(
											sidebarMenuButton(
												h,
												{
													className:
														"data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-sidebar-accent-foreground",
													slot: "popover-trigger",
													attributes: trigger,
												},
												rowContent(h),
											),
										),
									),
							},
							toParentMessage: (message) => Message.GotIosPromptPopoverMessage({ message }),
						}),
			]),
		],
	})
