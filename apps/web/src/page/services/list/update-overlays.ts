import type { Result } from "effect"
import { Command } from "foldkit"
import * as HoverCard from "@maple/views/ui/hover-card"
import * as Tooltip from "@maple/views/ui/tooltip"
import { PageOutMessage, type PageReturn } from "../../contract"
import {
	type CommitDetail,
	type CommitFailure,
	elapsedCommitArm as elapsedArm,
	initCommitCard,
	settleCommitDetail,
	stepCommitCard,
} from "../../kit/commit-card"
import { CommitCard, CopyCommitSha } from "./command"
import { Message, type RowTooltip } from "./message"
import type { Model } from "./model"
import { String as Str } from "effect"

// The table's row tooltips and the commit hover card: Models, trigger ids and their Messages.

type Return = PageReturn<Model, Message>

export const initOverlays = () => ({
	rolloutTooltip: Tooltip.init("services-rollout-tooltip", { side: "left" }),
	samplingTooltip: Tooltip.init("services-sampling-tooltip", { side: "bottom" }),
	unnamedTooltip: Tooltip.init("services-unnamed-tooltip", { side: "bottom" }),
	...initCommitCard("services-commit-card"),
})

const TOOLTIP_FIELD = {
	rollout: "rolloutTooltip",
	sampling: "samplingTooltip",
	unnamed: "unnamedTooltip",
} as const satisfies Record<RowTooltip, keyof Model>

/** A DOM-safe trigger id for one row's overlay; commit triggers end in the sha they look up. */
export const overlayTriggerId = (overlay: RowTooltip | "commit", rowKey: string, sha = ""): string =>
	`services-${overlay}-${Str.replace(/[^A-Za-z0-9_-]/g, "_")(rowKey)}${sha === "" ? "" : `-${sha}`}`

export const rowTooltipMessage = (model: Model, tooltip: RowTooltip, message: Tooltip.Message): Return => {
	const field = TOOLTIP_FIELD[tooltip]
	const next = Tooltip.update(model[field], message)
	return {
		model: { ...model, [field]: next.model },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotRowTooltipMessage({ tooltip, message: inner }),
		),
	}
}

/** The card's own update, plus the 20 ms arm a trigger enter starts and a leave cancels. */
export const commitCardMessage = (model: Model, message: HoverCard.Message): Return =>
	stepCommitCard(model, message, {
		toMessage: (inner) => Message.GotCommitCardMessage({ message: inner }),
		arm: CommitCard.Arm,
	})

export const elapsedCommitArm = (model: Model, orgId: string, sha: string, generation: number): Return =>
	elapsedArm(model, { orgId, sha, generation }, CommitCard.Fetch)

export const completedCommitDetail = (
	model: Model,
	sha: string,
	result: Result.Result<CommitDetail, CommitFailure>,
): Return => ({ model: settleCommitDetail(model, sha, result) })

/**
 * Copies the commit SHA and toasts. The card sits inside the row, so the click also bubbles to the
 * row's navigation: the page opens with the toast.
 */
export const clickedCopySha = (model: Model, sha: string, rowUrl: string): Return => ({
	model,
	commands: [CopyCommitSha({ sha, rowUrl })],
})

/** The navigation carries the write's outcome, so a failure is not lost with this page. */
export const copiedSha = (model: Model, rowUrl: string, isCopied: boolean): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: rowUrl,
		isReplace: false,
		toast: isCopied
			? { type: "success", title: "commit SHA copied", description: "" }
			: { type: "error", title: "Couldn't copy commit sha", description: "" },
	}),
})
