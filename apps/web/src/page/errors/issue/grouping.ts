import type { ErrorIssueGroupingResponse, ErrorIssueId, ErrorIssueSimilarResponse } from "@maple/domain/http"
import { Array as Arr, Result } from "effect"
import { AsyncData, type Command } from "foldkit"
import type * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import type { Resources } from "../../../platform/resources"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { keyed, runSteps, type Step as KitStep } from "../../kit/keyed-step"
import { FetchGrouping, FetchSimilar, MergeSimilarIssue, SplitOutFingerprint } from "./command"
import { tabOf } from "./derive"
import type { Message } from "./message"
import type { Model } from "./model"

// The Grouping tab's reads and writes: which fingerprints the issue owns and why, the issues that
// look like it, splitting a grouped fingerprint out and merging a look-alike in.

type Return = PageReturn<Model, Message>
type Step = KitStep<Model, Message>
type Refresh = (model: Model) => {
	readonly model: Model
	readonly commands: ReadonlyArray<Command.Command<Message, never, Resources>>
}

const NO_STEP: Step = { patch: {}, commands: [] }

/** Only an open Grouping tab on a loaded error issue reads, so the first paint never waits on it. */
const isGroupingOpen = (model: Model): boolean =>
	tabOf(model.search) === "grouping" &&
	AsyncData.matchData(model.detail.data, {
		onEmpty: () => false,
		onFailure: () => false,
		onData: (detail) => detail.kind === "error",
	})

export const groupingReads =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Step => {
		if (!isGroupingOpen(model)) return NO_STEP
		const grouping = groupingStep(context, mode)(model)
		const similar = similarStep(context, mode)(model)
		return {
			patch: { ...grouping.patch, ...similar.patch },
			commands: [...grouping.commands, ...similar.commands],
		}
	}

const groupingStep =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Step =>
		keyed<Model, Message, ErrorIssueGroupingResponse, LoadFailure>(
			model.grouping,
			requestKey(context.orgId, "errors.getIssueGrouping", model.issueId),
			mode,
			(next) => ({ grouping: next }),
			(key) => FetchGrouping({ key, issueId: model.issueId }),
		)

const similarStep =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Step =>
		keyed<Model, Message, ErrorIssueSimilarResponse, LoadFailure>(
			model.similar,
			requestKey(context.orgId, "errors.listSimilarIssues", model.issueId),
			mode,
			(next) => ({ similar: next }),
			(key) => FetchSimilar({ key, issueId: model.issueId }),
		)

export const retryGrouping = (model: Model, context: PageContext, slot: "grouping" | "similar"): Return =>
	runSteps(model, [
		slot === "grouping" ? groupingStep(context, "Refresh") : similarStep(context, "Refresh"),
	])

export const toggledSkippedFrames = (model: Model, fingerprintHash: string): Return => ({
	model: {
		...model,
		openSkippedFrames: model.openSkippedFrames.includes(fingerprintHash)
			? Arr.filter(model.openSkippedFrames, (hash) => hash !== fingerprintHash)
			: [...model.openSkippedFrames, fingerprintHash],
	},
})

const isGroupingBusy = (model: Model): boolean =>
	model.splittingHash !== null || model.mergingIssueId !== null

export const clickedSplitOut = (model: Model, fingerprintHash: string): Return =>
	isGroupingBusy(model)
		? { model }
		: {
				model: { ...model, splittingHash: fingerprintHash, groupingError: null },
				commands: [SplitOutFingerprint({ issueId: model.issueId, fingerprintHash })],
			}

export const clickedMergeSimilar = (model: Model, sourceIssueId: ErrorIssueId): Return =>
	isGroupingBusy(model)
		? { model }
		: {
				model: { ...model, mergingIssueId: sourceIssueId, groupingError: null },
				commands: [MergeSimilarIssue({ issueId: model.issueId, sourceIssueId })],
			}

/** A settled split or merge: the server's message beside its row on failure, else the issue and the tab read again. */
export const completedGroupingWrite = (
	model: Model,
	context: PageContext,
	result: Result.Result<null, LoadFailure>,
	copy: Readonly<{ target: string; success: string }>,
	refresh: Refresh,
): Return => {
	const settled = { ...model, splittingHash: null, mergingIssueId: null }
	return Result.match(result, {
		onFailure: (failure) => ({
			model: { ...settled, groupingError: { target: copy.target, message: failure.message } },
		}),
		onSuccess: () => {
			const refreshed = refresh(settled)
			const reread = runSteps(refreshed.model, [groupingReads(context, "Supersede")])
			return {
				model: reread.model,
				commands: [...refreshed.commands, ...(reread.commands ?? [])],
				outMessage: PageOutMessage.RequestedToast({
					type: "success",
					title: copy.success,
					description: "",
				}),
			}
		},
	})
}
