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

// The sidebar's nudge to install the iPhone app: a card over the footer rows with Apple's badge
// and, on a desktop, a QR code to the same listing. Dismissed once per user, in this browser.

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

/** The card, or nothing; the collapsed rail has no room for it. */
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
					gap: "3",
					className:
						"rounded-md border border-sidebar-border bg-background p-3 group-data-[collapsible=icon]:hidden",
					attributes: [h.AriaLabel(IOS_APP_NAME)],
				},
				[
					hstack(h, { align: "start", justify: "between", gap: "2" }, [
						vstack(h, { gap: "0.5", className: "min-w-0" }, [
							typography(h, { size: "ui", weight: "medium" }, ["Get Maple on your iPhone"]),
							typography(h, { size: "xs", tone: "muted" }, [
								"Critical alerts on your Lock Screen, and the trace behind every error.",
							]),
						]),
						iconButton(
							h,
							{
								label: "Dismiss",
								size: "icon-2xs",
								className: "-mt-0.5 -mr-1 shrink-0",
								attributes: [h.OnClick(Message.ClickedDismissIosPrompt({ userId }))],
							},
							[icon(h, "XmarkIcon", { size: 12 })],
						),
					]),
					hstack(h, { gap: "3" }, [
						// A phone opens the listing from the badge; a code to scan is for the desktop.
						...(model.isMobile
							? []
							: [
									qrCode(h, {
										value: IOS_APP_STORE_URL,
										label: "QR code to Maple Companion on the App Store",
										className: "size-16 shrink-0",
									}),
								]),
						h.a(
							[
								h.Href(IOS_APP_STORE_URL),
								h.Target("_blank"),
								h.Rel("noopener noreferrer"),
								h.AriaLabel("Download on the App Store"),
								h.Class(
									"rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
								),
							],
							[
								h.img([
									h.Src("/app-store-badge.svg"),
									h.Alt(""),
									h.Attribute("width", "108"),
									h.Attribute("height", "36"),
									h.Class("block h-9 w-auto"),
								]),
							],
						),
					]),
				],
			),
		],
	})
