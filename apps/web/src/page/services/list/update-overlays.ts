import type { Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as HoverCard from "../../../ui/hover-card"
import * as Tooltip from "../../../ui/tooltip"
import { PageOutMessage, type PageReturn } from "../../contract"
import { type CommitDetail, type CommitFailure, commitDetailKey, OPEN_DELAY_MS } from "../../kit/commit-card"
import { ArmCommitLookup, CopyCommitSha, FetchCommitDetail } from "./command"
import { Message, type RowTooltip } from "./message"
import type { Model } from "./model"

// The table's row tooltips and `CommitShaHoverCard`: Models, trigger ids and their Messages.

type Return = PageReturn<Model, Message>

export const initOverlays = () => ({
	rolloutTooltip: Tooltip.init("services-rollout-tooltip", { side: "left" }),
	samplingTooltip: Tooltip.init("services-sampling-tooltip", { side: "bottom" }),
	unnamedTooltip: Tooltip.init("services-unnamed-tooltip", { side: "bottom" }),
	commitCard: HoverCard.init("services-commit-card", {
		openDelayMs: OPEN_DELAY_MS,
		side: "bottom",
		align: "start",
		sideOffset: 6,
	}),
	commitDetails: {},
	commitArm: 0,
})

const TOOLTIP_FIELD = {
	rollout: "rolloutTooltip",
	sampling: "samplingTooltip",
	unnamed: "unnamedTooltip",
} as const satisfies Record<RowTooltip, keyof Model>

/** A DOM-safe trigger id for one row's overlay; commit triggers end in the sha they look up. */
export const overlayTriggerId = (overlay: RowTooltip | "commit", rowKey: string, sha = ""): string =>
	`services-${overlay}-${rowKey.replace(/[^A-Za-z0-9_-]/g, "_")}${sha === "" ? "" : `-${sha}`}`

const shaOfTrigger = (triggerId: string): string => triggerId.slice(-40)

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
export const commitCardMessage = (model: Model, message: HoverCard.Message): Return => {
	const next = HoverCard.update(model.commitCard, message)
	const lifted = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotCommitCardMessage({ message: inner }),
	)
	const arm = model.commitArm + 1
	if (message._tag === "EnteredTrigger") {
		const sha = shaOfTrigger(message.triggerId)
		const isArmed = model.commitDetails[sha] !== undefined
		return {
			model: { ...model, commitCard: next.model, commitArm: arm },
			commands: [...lifted, ...(isArmed ? [] : [ArmCommitLookup({ sha, generation: arm })])],
		}
	}
	if (message._tag === "LeftTrigger") {
		return { model: { ...model, commitCard: next.model, commitArm: arm }, commands: lifted }
	}
	return { model: { ...model, commitCard: next.model }, commands: lifted }
}

/** Once armed it stays armed: the lookup survives the pointer leaving. */
export const elapsedCommitArm = (model: Model, orgId: string, sha: string, generation: number): Return =>
	generation !== model.commitArm || model.commitDetails[sha] !== undefined
		? { model }
		: {
				model: { ...model, commitDetails: { ...model.commitDetails, [sha]: AsyncData.Loading() } },
				commands: [FetchCommitDetail({ key: commitDetailKey(orgId, sha), sha })],
			}

export const completedCommitDetail = (
	model: Model,
	sha: string,
	result: Result.Result<CommitDetail, CommitFailure>,
): Return => ({
	model: {
		...model,
		commitDetails: {
			...model.commitDetails,
			[sha]: AsyncData.settle(model.commitDetails[sha] ?? AsyncData.Loading(), result),
		},
	},
})

/**
 * `CopyableBadge label="commit SHA"`: writes the clipboard and toasts. The card sits
 * inside the row, so the click also bubbles to the row's `goToDetail`: the page opens with the toast.
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
