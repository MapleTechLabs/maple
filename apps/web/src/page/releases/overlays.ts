import { Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { Resources } from "../../platform/resources"
import * as HoverCard from "@maple/views/ui/hover-card"
import * as Tooltip from "@maple/views/ui/tooltip"
import { initMarkerCard } from "../kit/service-metrics/marker-card"
import {
	commitCardCommands,
	CommitCardMessages,
	CommitCardState,
	elapsedCommitArm,
	initCommitCard,
	settleCommitDetail,
	stepCommitCard,
} from "../kit/commit-card"

// The releases pages' overlays: the health pill's description tooltip, the commit hover card and the
// chart markers' card (one Model each, shared by every trigger on the page), and the commits the card looked up.

export const Model = Schema.Struct({
	healthTooltip: Tooltip.Model,
	/** The commit markers' hover card on the release's charts. */
	markerCard: HoverCard.Model,
	...CommitCardState.fields,
})
export type Model = typeof Model.Type

export const init = (prefix: string): Model => ({
	healthTooltip: Tooltip.init(`${prefix}-health-tooltip`),
	markerCard: initMarkerCard(`${prefix}-marker-card`),
	...initCommitCard(`${prefix}-commit-card`),
})

export const Message = defineMessageUnion({
	GotHealthTooltipMessage: { message: Tooltip.Message },
	GotMarkerCardMessage: { message: HoverCard.Message },
	...CommitCardMessages,
})
export type Message = typeof Message.Type

/** The commit hover card's arm timer and its commit read. */
export const CommitCard = commitCardCommands(
	{ arm: "ArmReleasesCommitLookup", fetch: "FetchReleasesCommitDetail" },
	{ elapsed: Message.ElapsedCommitArm, completed: Message.CompletedFetchCommitDetail },
)

type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

/** A commit trigger's id ends in the sha it looks up. */
export const commitTriggerId = (scope: string, sha: string): string => `${scope}-commit-${sha}`

export const update = (model: Model, message: Message, orgId: string): Return =>
	Message.match<Return>(message, {
		GotHealthTooltipMessage: ({ message: inner }) => {
			const next = Tooltip.update(model.healthTooltip, inner)
			return {
				model: { ...model, healthTooltip: next.model },
				commands: Command.mapMessages(next.commands ?? [], (tooltip) =>
					Message.GotHealthTooltipMessage({ message: tooltip }),
				),
			}
		},
		GotMarkerCardMessage: ({ message: inner }) => {
			const next = HoverCard.update(model.markerCard, inner)
			return {
				model: { ...model, markerCard: next.model },
				commands: Command.mapMessages(next.commands ?? [], (card) =>
					Message.GotMarkerCardMessage({ message: card }),
				),
			}
		},
		GotCommitCardMessage: ({ message: inner }) =>
			stepCommitCard(model, inner, {
				toMessage: (card) => Message.GotCommitCardMessage({ message: card }),
				arm: CommitCard.Arm,
			}),
		ElapsedCommitArm: ({ sha, generation }) =>
			elapsedCommitArm(model, { orgId, sha, generation }, CommitCard.Fetch),
		CompletedFetchCommitDetail: ({ sha, result }) => ({ model: settleCommitDetail(model, sha, result) }),
	})
