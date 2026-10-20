import { Duration, Effect, type Result, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { Resources } from "../../platform/resources"
import * as HoverCard from "../../ui/hover-card"
import * as Tooltip from "../../ui/tooltip"
import {
	ARM_DELAY_MS,
	type CommitDetail,
	CommitDetail as CommitDetailSchema,
	CommitDetailData,
	type CommitFailure,
	CommitFailure as CommitFailureSchema,
	commitDetailKey,
	loadCommitDetail,
	OPEN_DELAY_MS,
} from "../kit/commit-card"

// The releases pages' overlays: `ReleaseHealthPill`'s description tooltip and `CommitShaHoverCard`
// (one Model each, shared by every trigger on the page), and the commits the card looked up.

export const Model = Schema.Struct({
	healthTooltip: Tooltip.Model,
	commitCard: HoverCard.Model,
	commitDetails: Schema.Record(Schema.String, CommitDetailData.schema),
	/** A trigger enter's generation: the 20 ms arm only fires for the latest one. */
	commitArm: Schema.Number,
})
export type Model = typeof Model.Type

export const init = (prefix: string): Model => ({
	healthTooltip: Tooltip.init(`${prefix}-health-tooltip`),
	commitCard: HoverCard.init(`${prefix}-commit-card`, {
		openDelayMs: OPEN_DELAY_MS,
		side: "bottom",
		align: "start",
		sideOffset: 6,
	}),
	commitDetails: {},
	commitArm: 0,
})

export const Message = defineMessageUnion({
	GotHealthTooltipMessage: { message: Tooltip.Message },
	GotCommitCardMessage: { message: HoverCard.Message },
	ElapsedCommitArm: { sha: Schema.String, generation: Schema.Number },
	CompletedFetchCommitDetail: { sha: Schema.String, result: Schema.Result(CommitDetailSchema, CommitFailureSchema) },
})
export type Message = typeof Message.Type

/** `CommitShaHoverCard`'s arm timer: the lookup starts 20 ms into a hover, ahead of the card. */
export const ArmCommitLookup = Command.define("ArmReleasesCommitLookup", {
	args: { sha: Schema.String, generation: Schema.Number },
	messages: [Message.ElapsedCommitArm],
	execute: ({ sha, generation }) =>
		Effect.as(Effect.sleep(Duration.millis(ARM_DELAY_MS)), Message.ElapsedCommitArm({ sha, generation })),
})

/** `commitQueryAtom(sha)`, for the hover card. */
export const FetchCommitDetail = Command.define("FetchReleasesCommitDetail", {
	args: { key: Schema.String, sha: Schema.String },
	messages: [Message.CompletedFetchCommitDetail],
	execute: ({ key, sha }) =>
		Effect.map(loadCommitDetail(key, sha), (result) => Message.CompletedFetchCommitDetail({ sha, result })),
})

type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

/** A commit trigger's id ends in the sha it looks up. */
export const commitTriggerId = (scope: string, sha: string): string => `${scope}-commit-${sha}`
const shaOfTrigger = (triggerId: string): string => triggerId.slice(-40)

const commitCardStep = (model: Model, message: HoverCard.Message): Return => {
	const next = HoverCard.update(model.commitCard, message)
	const lifted = Command.mapMessages(next.commands ?? [], (inner) => Message.GotCommitCardMessage({ message: inner }))
	const arm = model.commitArm + 1
	if (message._tag === "EnteredTrigger") {
		const sha = shaOfTrigger(message.triggerId)
		const isArmed = model.commitDetails[sha] !== undefined
		return {
			model: { ...model, commitCard: next.model, commitArm: arm },
			commands: [...lifted, ...(isArmed ? [] : [ArmCommitLookup({ sha, generation: arm })])],
		}
	}
	if (message._tag === "LeftTrigger") return { model: { ...model, commitCard: next.model, commitArm: arm }, commands: lifted }
	return { model: { ...model, commitCard: next.model }, commands: lifted }
}

const settled = (model: Model, sha: string, result: Result.Result<CommitDetail, CommitFailure>): Model => ({
	...model,
	commitDetails: { ...model.commitDetails, [sha]: AsyncData.settle(model.commitDetails[sha] ?? AsyncData.Loading(), result) },
})

export const update = (model: Model, message: Message, orgId: string): Return =>
	Message.match<Return>(message, {
		GotHealthTooltipMessage: ({ message: inner }) => {
			const next = Tooltip.update(model.healthTooltip, inner)
			return {
				model: { ...model, healthTooltip: next.model },
				commands: Command.mapMessages(next.commands ?? [], (tooltip) => Message.GotHealthTooltipMessage({ message: tooltip })),
			}
		},
		GotCommitCardMessage: ({ message: inner }) => commitCardStep(model, inner),
		// Once armed it stays armed: the lookup survives the pointer leaving.
		ElapsedCommitArm: ({ sha, generation }) =>
			generation !== model.commitArm || model.commitDetails[sha] !== undefined
				? { model }
				: {
						model: { ...model, commitDetails: { ...model.commitDetails, [sha]: AsyncData.Loading() } },
						commands: [FetchCommitDetail({ key: commitDetailKey(orgId, sha), sha })],
					},
		CompletedFetchCommitDetail: ({ sha, result }) => ({ model: settled(model, sha, result) }),
	})
