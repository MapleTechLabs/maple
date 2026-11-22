import type { ErrorIssueDetailResponse } from "@maple/domain/http"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "@maple/views/ui/copy-button"
import { badge } from "@maple/views/ui/display"
import * as HoverCard from "@maple/views/ui/hover-card"
import { icon, type IconName } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { stripClass } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { docsLink } from "../../kit/signal-empty-state"
import {
	type ContextItem,
	contextSetupPrompt,
	type MissingContext,
	missingContextItems,
	missingContextLine,
} from "../kit/context-setup-prompt"
import { Message } from "./message"
import type { Model } from "./model"
import { occurrenceColumnsOf } from "./view-tables"

type H = HtmlBuilder<Message>

/** What no sample in the window carries; nothing to say with no samples. */
export const missingContextOf = (detail: ErrorIssueDetailResponse): MissingContext | null => {
	if (detail.sampleTraces.length === 0) return null
	const columns = occurrenceColumnsOf(detail.sampleTraces)
	return columns.release && columns.user ? null : { release: !columns.release, user: !columns.user }
}

const ITEM_LOOK = {
	release: { glyph: "TagIcon", tone: TONE_SOFT.live },
	user: { glyph: "UserIcon", tone: TONE_SOFT.done },
} satisfies Record<ContextItem["key"], { glyph: IconName; tone: string }>

/** One missing attribute: its mark, what it adds, and exactly what to set and where. */
const itemRow = (h: H, item: ContextItem): Html =>
	hstack(h, { gap: "3", align: "start", className: cn(stripClass("block"), "px-4 py-3") }, [
		hstack(
			h,
			{
				align: "center",
				justify: "center",
				as: "span",
				className: cn("size-7 shrink-0 rounded-md", ITEM_LOOK[item.key].tone),
				attributes: [h.AriaHidden(true)],
			},
			[icon(h, ITEM_LOOK[item.key].glyph, { size: 14 })],
		),
		vstack(h, { gap: "1", shrink: true, className: "min-w-0" }, [
			hstack(h, { gap: "2", align: "center" }, [
				typography(h, { size: "sm", tone: "foreground", weight: "medium" }, [item.title]),
				badge(h, { variant: "warn" }, ["Not set"]),
			]),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [item.gain]),
			typography(h, { size: "2xs", tone: "muted", as: "p" }, [
				"Set ",
				inlineCode(h, { variant: "chip", size: "2xs", tone: "foreground" }, [item.attribute]),
				` ${item.where}.`,
			]),
		]),
	])

const cardContent = (h: H, missing: MissingContext): ReadonlyArray<Html> => [
	vstack(h, { gap: "0.5", className: "px-4 pt-3 pb-2.5" }, [
		typography(h, { size: "sm", tone: "foreground", weight: "medium" }, [
			"Give every error more context",
		]),
		typography(h, { size: "xs", tone: "muted", as: "p" }, [
			"Set these in your OpenTelemetry setup. New errors carry them right away.",
		]),
	]),
	...Arr.map(missingContextItems(missing), (item) => itemRow(h, item)),
	hstack(h, { gap: "1.5", align: "center", className: cn(stripClass("block"), "px-4 py-2.5") }, [
		icon(h, "SparkleIcon", { size: 12, className: "shrink-0 text-primary" }),
		typography(h, { size: "2xs", tone: "muted" }, ["Copy setup prompt hands this to your coding agent."]),
	]),
]

/**
 * The occurrences table's foot when its errors carry no release or no user: what adding them gets
 * you, a card that explains each one, a prompt that has a coding agent add them, and the docs.
 */
export const occurrenceSetupFoot = (
	h: H,
	model: Model,
	detail: ErrorIssueDetailResponse,
): ReadonlyArray<Html> => {
	const missing = missingContextOf(detail)
	if (missing === null) return []
	const card = h.submodel({
		slotId: model.setupCard.id,
		model: model.setupCard,
		view: HoverCard.view,
		toParentMessage: (message) => Message.GotSetupCardMessage({ message }),
		viewInputs: {
			className: "w-80 p-0",
			toContent: () => cardContent(h, missing),
			toView: ({ trigger, portal }) =>
				hstack(h, { gap: "1", align: "center", as: "span", className: "shrink-0" }, [
					hstack(
						h,
						{
							gap: "1",
							align: "center",
							inline: true,
							as: "span",
							className:
								"cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground active:text-foreground",
							attributes: [...trigger, h.Tabindex(0)],
						},
						[icon(h, "CircleInfoIcon", { size: 12 }), "How to set it up"],
					),
					portal,
				]),
		},
	})
	return [
		hstack(
			h,
			{ gap: "3", align: "center", justify: "between", wrap: true, className: stripClass("foot") },
			[
				hstack(h, { gap: "2", align: "center", wrap: true, shrink: true, className: "min-w-0" }, [
					hstack(
						h,
						{
							align: "center",
							justify: "center",
							as: "span",
							className: cn("size-5 shrink-0 rounded-sm", TONE_SOFT.live),
							attributes: [h.AriaHidden(true)],
						},
						[icon(h, "SparkleIcon", { size: 11 })],
					),
					typography(h, { size: "xs", tone: "foreground", weight: "medium" }, [
						missingContextLine(missing),
					]),
					card,
				]),
				hstack(h, { gap: "3", align: "center", className: "shrink-0" }, [
					docsLink(h, missing.user ? "identifyingUsers" : "instrumentation", "Docs"),
					CopyButton.view(h, {
						model: model.setupPromptCopy,
						value: contextSetupPrompt(detail.issue.serviceName, missing),
						label: "setup prompt",
						idleLabel: "Copy setup prompt",
						copiedLabel: "Copied",
						variant: "outline",
						size: "xs",
						toParentMessage: (message) => Message.GotSetupPromptCopyMessage({ message }),
					}),
				]),
			],
		),
	]
}
