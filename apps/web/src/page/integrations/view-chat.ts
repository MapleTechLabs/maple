import type { ChatConnectorManifest } from "@maple/chat-platform/manifests"
import type { V2ChatConnector } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { emptyMessage } from "../../ui/empty"
import { item, itemActions, itemContent, itemDescription, itemTitle } from "../../ui/item"
import { skeleton } from "../../ui/skeleton"
import { manifestGlyph } from "../../ui/manifest-glyph"
import { Message } from "./message"
import type { Model } from "./model"

// The chat card's parts; the card is view-chat-card.ts.

type H = HtmlBuilder<Message>

/** `ChatIdentityRow`: the viewer's own chat account. */
export const identityRow = (
	h: H,
	model: Model,
	platform: string,
	identity: V2ChatConnector["identity"],
): Html => {
	const shown = identity === undefined ? undefined : (identity.display_name ?? identity.external_user_id)
	return item(h, { variant: "card", className: "gap-3 px-4 py-3" }, [
		itemContent(
			h,
			[
				itemTitle(h, ["Your ", platform, " account"]),
				itemDescription(
					h,
					[
						shown === undefined
							? `Link it so Maple knows it's you acting from ${platform}.`
							: `Linked as ${shown}`,
					],
					"truncate text-2xs",
					shown,
				),
			],
			"gap-0.5",
		),
		itemActions(h, [
			button(
				h,
				{
					size: "sm",
					variant: "outline",
					isLoading: model.chatCard.identityBusy,
					attributes: [h.OnClick(Message.ClickedChatIdentity())],
				},
				[identity === undefined ? "Link your account" : "Unlink"],
			),
		]),
	])
}

export const chatCardLoading = (h: H): Html =>
	emptyMessage(
		h,
		{
			dashed: true,
			className: "flex min-h-70 flex-col items-center justify-center gap-4 border-input px-6 py-10",
		},
		[
			skeleton(h, "size-14 rounded-xl"),
			skeleton(h, "h-4 w-72 max-w-full"),
			skeleton(h, "h-9 w-36 rounded-md"),
		],
	)

/** The mark in `currentColor` (`monoIcon`), for the filled button and the dim backers. */
export const monoGlyph = (h: H, manifest: ChatConnectorManifest, size = 24): Html =>
	manifestGlyph(h, manifest.icon, size, { monochrome: true })
