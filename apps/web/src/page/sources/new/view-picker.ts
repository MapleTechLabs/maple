import type { PullSourcePlatform, PushSourcePlatform, SourcePlatform } from "@maple/domain/primitives"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { PLATFORMS, platformTile, PULL_PLATFORMS, PUSH_PLATFORMS } from "../kit/platforms"
import { Message } from "./message"

// `PlatformPicker`: step 1.

type H = HtmlBuilder<Message>

const platformCard = (h: H, platform: SourcePlatform, onSelect: Message): Html => {
	const meta = PLATFORMS[platform]
	return h.button(
		[
			h.Key(platform),
			h.Type("button"),
			h.OnClick(onSelect),
			h.Class(
				cn(
					"group bg-card flex items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors",
					"hover:bg-muted/40 focus-visible:ring-ring outline-none focus-visible:ring-2",
				),
			),
		],
		[
			platformTile(h, platform),
			h.span(
				[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
				[
					h.span([h.Class("truncate text-sm font-medium")], [meta.label]),
					h.span([h.Class("text-muted-foreground truncate text-xs")], [meta.description]),
				],
			),
			icon(h, "ChevronRightIcon", {
				size: 14,
				className: "text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
			}),
		],
	)
}

const section = (h: H, title: string, cards: ReadonlyArray<Html>): Html =>
	h.section(
		[h.Class("flex flex-col gap-3")],
		[eyebrow(h, {}, [title]), h.div([h.Class("grid gap-2 sm:grid-cols-2 xl:grid-cols-3")], cards)],
	)

/** Push platforms create a source here, pull platforms open their integration. */
export const platformPicker = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-8")],
		[
			section(
				h,
				"Send with OpenTelemetry",
				PUSH_PLATFORMS.map((platform: PushSourcePlatform) =>
					platformCard(h, platform, Message.ClickedPushPlatform({ platform })),
				),
			),
			section(
				h,
				"Connect an integration",
				PULL_PLATFORMS.map((platform: PullSourcePlatform) =>
					platformCard(h, platform, Message.ClickedPullPlatform({ platform })),
				),
			),
		],
	)
