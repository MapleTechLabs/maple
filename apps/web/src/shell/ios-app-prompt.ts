import { IOS_APP_NAME, IOS_APP_STORE_URL } from "@maple/domain/mobile-app"
import { writeLocalStorage } from "@maple/ui/lib/local-storage"
import { iconButton } from "@maple/views/ui/icon-button"
import { icon } from "@maple/views/ui/icon"
import { qrCode } from "@maple/views/ui/qr-code"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "./message"
import type { Model, ShellClerk } from "./model"

// The sidebar's nudge to install the iPhone app: a small card over the footer rows, on the rows'
// own inset, with a QR code (desktop only) beside Apple's badge. Dismissed once per user, in this browser.

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

/** The signed-in user the card is for: none self-hosted, before Clerk answers, or once they closed it. */
export const iosPromptUser = (model: Model, clerk: ShellClerk | null): Option.Option<string> =>
	Option.filter(
		clerk === null ? Option.none() : clerk.maybeUserId,
		(userId) => !Arr.contains(model.iosPromptDismissedUsers, userId),
	)

const STORE_LABEL = "Download on the App Store"

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

/** The card, or nothing; the collapsed rail and a short window have no room for it. */
export const iosAppPrompt = (
	h: HtmlBuilder<Message>,
	model: Model,
	clerk: ShellClerk | null,
): ReadonlyArray<Html> =>
	Option.match(iosPromptUser(model, clerk), {
		onNone: () => [],
		onSome: (userId) => [
			vstack(
				h,
				{
					as: "section",
					gap: "2",
					// The Search row's surface. The footer does not scroll, so a short window drops the card.
					className:
						"mt-2 rounded-lg border border-sidebar-border bg-background p-3 group-data-[collapsible=icon]:hidden [@media(max-height:700px)]:hidden",
					attributes: [h.AriaLabel(IOS_APP_NAME)],
				},
				[
					hstack(h, { align: "start", justify: "between", gap: "2" }, [
						typography(h, { size: "ui", weight: "medium" }, ["Maple on your iPhone"]),
						iconButton(
							h,
							{
								label: "Dismiss",
								size: "icon-2xs",
								className: "-mr-1 shrink-0",
								attributes: [h.OnClick(Message.ClickedDismissIosPrompt({ userId }))],
							},
							[icon(h, "XmarkIcon", { size: 12 })],
						),
					]),
					hstack(h, { gap: "3", align: "stretch" }, [
						// A phone opens the listing from the badge; a code to scan is for the desktop.
						...(model.isMobile
							? []
							: [
									h.div(
										[h.Class("shrink-0 rounded-md border border-sidebar-border p-1")],
										[
											qrCode(h, {
												value: IOS_APP_STORE_URL,
												label: `QR code to ${IOS_APP_NAME} on the App Store`,
												className: "block size-16",
											}),
										],
									),
								]),
						vstack(h, { justify: "between", gap: "1.5", className: "min-w-0" }, [
							typography(h, { size: "xs", tone: "muted", as: "p" }, [
								"Critical alerts on your Lock Screen.",
							]),
							storeBadge(h),
						]),
					]),
				],
			),
		],
	})
