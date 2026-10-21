import { CodeReviewDetail, PrReviewId } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import { FrameMessage } from "../kit/frame"
import { SheetMessage } from "../kit/review-sheet"
import { context, names, NOW, PAYMENTS, window } from "../kit/test-fixtures"
import { Message, type Model } from "./model"
import { init, routeChanged, update } from "./update"

type Search = Parameters<typeof init>[0]["search"]

const REVIEW = Schema.decodeSync(PrReviewId)("00000c02-0000-4000-8000-000000000001")
const OTHER = Schema.decodeSync(PrReviewId)("00000c02-0000-4000-8000-000000000002")

const review = {
	id: REVIEW, repositoryId: PAYMENTS, repositoryFullName: "acme-shop/payments", number: 7, title: "Fix", url: "https://github.com/acme-shop/payments/pull/7",
	authorLogin: null, headSha: "a".repeat(40), status: "completed", skipReason: null, verdict: null, score: null, confidence: null, findings: 0,
	criticalFindings: 0, commentUrl: null, publishError: null, error: null, model: null, createdAt: NOW, finishedAt: null, mergedAt: null,
}
const detailOf = Schema.decodeUnknownSync(CodeReviewDetail)({
	review, report: null, checkRunUrl: null, reviewUrl: null, inputTokens: null, outputTokens: null, startedAt: null, history: [], findings: [],
})

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const resolved = Message.GotFrameMessage({
	message: FrameMessage.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
})
const windowed = (search: Search = {}) => pageUpdate(init({ search }, context).model, resolved)
const sheet = (message: SheetMessage) => Message.GotSheetMessage({ message })

describe("code review pull requests", () => {
	test("entry reads the list and the author list once the window resolves", () => {
		expect(names(windowed().commands)).toEqual(
			expect.arrayContaining(["FetchCodeReviewReviews", "FetchCodeReviewReviewAuthors"]),
		)
	})

	test("a deep link to a review opens the sheet and reads the review", () => {
		const entry = init({ search: { review: REVIEW } }, context)
		expect(entry.model.sheet.reviewId).toBe(REVIEW)
		expect(entry.model.sheet.dialog.isOpen).toBe(true)
		expect(names(entry.commands)).toContain("FetchCodeReviewDetail")
	})

	test("clicking a review asks for its URL; the list is not read again for it", () => {
		const loaded = windowed().model
		const clicked = pageUpdate(loaded, Message.ClickedReview({ reviewId: REVIEW }))
		expect(clicked.outMessage).toMatchObject({
			_tag: "RequestedNavigation",
			url: `/code-review/pull-requests?review=${REVIEW}`,
		})
		const opened = pageUpdate(
			routeChanged(loaded, { search: { review: REVIEW } }, context).model,
			resolved,
		)
		expect(names(opened.commands)).toEqual([])
	})

	test("Escape closes the sheet by dropping `review` from the URL", () => {
		const open = init({ search: { review: REVIEW } }, context).model
		const dismissed = pageUpdate(
			open,
			sheet(SheetMessage.GotDialogMessage({ message: Dialog.Message.PressedEscape() })),
		)
		expect(dismissed.outMessage).toMatchObject({ url: "/code-review/pull-requests" })
		expect(dismissed.model.sheet.dialog.isOpen).toBe(false)
	})

	test("a review answer for another review is dropped", () => {
		const open = init({ search: { review: REVIEW } }, context).model
		const stale = pageUpdate(
			open,
			sheet(
				SheetMessage.CompletedFetchDetail({
					key: "other",
					result: Result.fail(toLoadFailure("boom")),
				}),
			),
		)
		expect(stale.model.sheet.detail).toEqual(open.sheet.detail)
	})

	test("opening another review shows its skeleton, then its own error, never the previous review", () => {
		const open = init({ search: { review: REVIEW } }, context).model
		const loaded = pageUpdate(
			open,
			sheet(
				SheetMessage.CompletedFetchDetail({
					key: open.sheet.detail.key ?? "",
					result: Result.succeed(detailOf),
				}),
			),
		).model
		expect(AsyncData.isSuccess(loaded.sheet.detail.data)).toBe(true)
		const moved = routeChanged(loaded, { search: { review: OTHER } }, context).model
		expect(moved.sheet.detail.data._tag).toBe("Loading")
		const failed = pageUpdate(
			moved,
			sheet(
				SheetMessage.CompletedFetchDetail({
					key: moved.sheet.detail.key ?? "",
					result: Result.fail(toLoadFailure("boom")),
				}),
			),
		).model
		expect(failed.sheet.detail.data._tag).toBe("Failure")
	})
})
