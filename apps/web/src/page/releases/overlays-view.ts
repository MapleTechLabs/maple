import { cn } from "@maple/ui/lib/utils"
import type { ReleaseHealth } from "../../components/releases/release-model"
import { AsyncData } from "foldkit"
import { childAttributes, type Html, type HtmlBuilder } from "foldkit/html"
import { badge } from "../../ui/display"
import * as HoverCard from "../../ui/hover-card"
import * as Tooltip from "../../ui/tooltip"
import { commitDetailBody, isResolvableSha } from "../kit/commit-card"
import { PILL_CLASS, RELEASE_HEALTH_DESCRIPTION, RELEASE_HEALTH_LABEL } from "./kit"
import { commitTriggerId, Message, type Model } from "./overlays"

// The triggers of the releases overlays. Each trigger embeds the shared Model as its own
// submodel; only the trigger the popup is anchored to carries its portal (moved to `<body>`).

export type Overlays<M> = Readonly<{
	model: Model
	toParent: (message: Message) => M
	clock: Readonly<{ nowMs: number; timeZone: string }>
}>

/** `ReleaseHealthPill`: the badge is the tooltip trigger, the description its popup. */
export const releaseHealthPill = <M>(
	h: HtmlBuilder<M>,
	overlays: Overlays<M>,
	triggerId: string,
	health: ReleaseHealth,
	label?: string,
	className?: string,
): Html =>
	h.submodel({
		slotId: `${triggerId}-tooltip`,
		model: overlays.model.healthTooltip,
		view: Tooltip.view,
		toParentMessage: (message) => overlays.toParent(Message.GotHealthTooltipMessage({ message })),
		viewInputs: {
			triggerIds: [triggerId],
			toContent: () => [RELEASE_HEALTH_DESCRIPTION[health]],
			toView: ({ trigger, portal }) =>
				badge(
					h,
					{
						size: "xs",
						pill: true,
						mono: true,
						className: cn("cursor-default font-normal", PILL_CLASS[health], className),
						attributes: [
							...trigger(triggerId),
							...childAttributes([h.DataAttribute("slot", "tooltip-trigger")]),
						],
					},
					[
						label ?? RELEASE_HEALTH_LABEL[health],
						...(portal !== null && overlays.model.healthTooltip.triggerId === triggerId
							? [portal]
							: []),
					],
				),
		},
	})

/** `CommitShaHoverCard`: a full sha opens the commit card on hover; any other is plain text. */
export const commitTrigger = <M>(
	h: HtmlBuilder<M>,
	overlays: Overlays<M>,
	scope: string,
	sha: string,
	className: string,
	children: ReadonlyArray<Html | string>,
): Html => {
	if (!isResolvableSha(sha)) return h.span([h.Class(className)], children)
	const id = commitTriggerId(scope, sha)
	return h.submodel({
		slotId: `${id}-card`,
		model: overlays.model.commitCard,
		view: HoverCard.view,
		toParentMessage: (message) => overlays.toParent(Message.GotCommitCardMessage({ message })),
		viewInputs: {
			triggerIds: [id],
			className: "w-80 p-0",
			toContent: () => [
				commitDetailBody(h, overlays.model.commitDetails[sha] ?? AsyncData.Loading(), overlays.clock),
			],
			toView: ({ triggerFor, portal }) =>
				h.span(
					[h.Class(cn("cursor-default", className)), ...triggerFor(id)],
					[
						...children,
						...(portal !== null && overlays.model.commitCard.triggerId === id ? [portal] : []),
					],
				),
		},
	})
}
