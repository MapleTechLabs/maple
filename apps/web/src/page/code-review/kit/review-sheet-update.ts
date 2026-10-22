import type { CodeReviewCiRunsResponse, CodeReviewDetail, PrReviewId } from "@maple/domain/http"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import * as Dialog from "../../../ui/dialog"
import type { PageContext } from "../../contract"
import { cachedStep, remember } from "./page-steps"
import {
	FetchPullRequestRuns,
	FetchReviewDetail,
	ReadCiClock,
	type ReviewSheet,
	SheetMessage,
	type SheetOut,
} from "./review-sheet"

export type SheetCommand = Command.Command<SheetMessage, never, Resources>
export type SheetReturn = Readonly<{
	sheet: ReviewSheet
	commands: ReadonlyArray<SheetCommand>
	out: SheetOut | null
}>

export const initSheet = (id: string): ReviewSheet => ({
	dialog: Dialog.init(id, "sheet"),
	reviewId: null,
	detail: Keyed.idle(),
	detailCache: {},
	ciRuns: Keyed.idle(),
	ciCache: {},
	nowMs: 0,
})

type DialogReturn = ReturnType<typeof Dialog.update>

export const liftDialog = (
	sheet: ReviewSheet,
	result: DialogReturn,
): Readonly<{ sheet: ReviewSheet; commands: ReadonlyArray<SheetCommand> }> => ({
	sheet: { ...sheet, dialog: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) =>
		SheetMessage.GotDialogMessage({ message }),
	),
})

/** `retainedInternalQuery("codeReview", "getReview")`; a retained answer mounts the runs at once. */
export const readDetail = (
	sheet: ReviewSheet,
	reviewId: PrReviewId,
	context: PageContext,
	mode: Keyed.RequestMode,
): Readonly<{ sheet: ReviewSheet; commands: ReadonlyArray<SheetCommand> }> => {
	const key = requestKey(context.orgId, "codeReview.getReview", { params: { reviewId } })
	const step = cachedStep<ReviewSheet, SheetMessage, CodeReviewDetail, LoadFailure>(
		sheet.detailCache,
		sheet.nowMs,
		sheet.detail,
		key,
		mode,
		(detail) => ({ detail }),
		(fetchKey) => FetchReviewDetail({ key: fetchKey, reviewId }),
	)
	const next: ReviewSheet = { ...sheet, ...step.patch }
	const isCached = step.commands.length === 0 && AsyncData.isSuccess(next.detail.data)
	return { sheet: next, commands: isCached ? [ReadCiClock({ key })] : step.commands }
}

/** The route's `review` changed: open on the new review (reading it), or close. */
export const syncSheet = (
	sheet: ReviewSheet,
	reviewId: PrReviewId | undefined,
	context: PageContext,
	nowMs: number,
): SheetReturn => {
	if ((reviewId ?? null) === sheet.reviewId) return { sheet, commands: [], out: null }
	if (reviewId === undefined) {
		const closed = liftDialog({ ...sheet, reviewId: null }, Dialog.close(sheet.dialog))
		return { ...closed, out: null }
	}
	// A new `ReviewDetailBody` reads its own atom: the previous review is never shown while it loads.
	const opened = liftDialog(
		{
			...sheet,
			reviewId,
			detail: Keyed.idle(),
			ciRuns: Keyed.idle(),
			nowMs: Math.max(sheet.nowMs, nowMs),
		},
		Dialog.open(sheet.dialog),
	)
	const read = readDetail(opened.sheet, reviewId, context, "Load")
	return { sheet: read.sheet, commands: [...opened.commands, ...read.commands], out: null }
}

const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000
const MINUTE_MS = 60_000
/** `SHOWN`: the latest runs the sheet lists. */
export const CI_RUNS_SHOWN = 20

/** `PullRequestCiRuns` mounted: its window ends at the minute after `nowMs`. */
const readRuns = (sheet: ReviewSheet, nowMs: number, context: PageContext): SheetReturn =>
	Option.match(AsyncData.getData(sheet.detail.data), {
		onNone: () => ({ sheet, commands: [], out: null }),
		onSome: ({ review }) => {
			const now = Math.ceil(nowMs / MINUTE_MS) * MINUTE_MS
			const query = {
				startTime: now - LOOKBACK_MS,
				endTime: now,
				repositoryId: review.repositoryId,
				pullRequest: review.number,
				limit: CI_RUNS_SHOWN,
			}
			const step = cachedStep<ReviewSheet, SheetMessage, CodeReviewCiRunsResponse, LoadFailure>(
				sheet.ciCache,
				nowMs,
				sheet.ciRuns,
				requestKey(context.orgId, "codeReview.ciRuns", { query }),
				"Load",
				(ciRuns) => ({ ciRuns }),
				(key) => FetchPullRequestRuns({ key, query }),
			)
			return { sheet: { ...sheet, ...step.patch, nowMs }, commands: step.commands, out: null }
		},
	})

export const updateSheet = (sheet: ReviewSheet, message: SheetMessage, context: PageContext): SheetReturn =>
	SheetMessage.match<SheetReturn>(message, {
		GotDialogMessage: ({ message: inner }) => {
			const result = Dialog.update(sheet.dialog, inner)
			const lifted = liftDialog(sheet, result)
			return { ...lifted, out: result.outMessage?._tag === "Closed" ? { _tag: "Dismissed" } : null }
		},
		CompletedFetchDetail: ({ key, result }) => {
			const next: ReviewSheet = {
				...sheet,
				detail: Keyed.accept(sheet.detail, key, result),
				detailCache: remember(sheet.detailCache, sheet.nowMs, key, result),
			}
			const isCurrent = sheet.detail.key === key && Result.isSuccess(result)
			return { sheet: next, commands: isCurrent ? [ReadCiClock({ key })] : [], out: null }
		},
		ReadCiClock: ({ key, nowMs }) =>
			key === sheet.detail.key ? readRuns(sheet, nowMs, context) : { sheet, commands: [], out: null },
		CompletedFetchCiRuns: ({ key, result }) => ({
			sheet: {
				...sheet,
				ciRuns: Keyed.accept(sheet.ciRuns, key, result),
				ciCache: remember(sheet.ciCache, sheet.nowMs, key, result),
			},
			commands: [],
			out: null,
		}),
		ClickedRetry: () =>
			sheet.reviewId === null
				? { sheet, commands: [], out: null }
				: { ...readDetail(sheet, sheet.reviewId, context, "Refresh"), out: null },
		ClickedHistoryEntry: ({ reviewId }) => ({
			sheet,
			commands: [],
			out: { _tag: "SelectedReview", reviewId },
		}),
	})
