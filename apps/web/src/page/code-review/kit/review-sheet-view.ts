import type { CodeReviewDetail } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import * as SheetStyles from "@maple/ui/styles/ui/sheet"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { descriptionId, titleId } from "../../../ui/dialog"
import * as DialogView from "../../../ui/dialog-view"
import { linkButton } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { skeleton } from "../../../ui/skeleton"
import { truncatedId } from "../../../ui/truncated-id"
import { authorLabel } from "./author"
import type { ReviewSheet } from "./review-sheet"
import { SheetMessage } from "./review-sheet"
import { reviewSections } from "./review-sheet-sections"

// `ReviewDetailSheet`, `ReviewDetailBody` and `SheetDetailHeader`.

type H = HtmlBuilder<SheetMessage>

const sheetHeader = (h: H, children: ReadonlyArray<Html>): Html =>
	h.div(
		[
			h.Class(cn(SheetStyles.sheetHeaderStyles, "gap-1.5 pr-14")),
			h.DataAttribute("slot", "sheet-header"),
		],
		children,
	)

const sheetTitle = (h: H, id: string, className: string | undefined, children: ReadonlyArray<Html>): Html =>
	h.h2(
		[
			h.Class(cn(SheetStyles.sheetTitleStyles, className)),
			h.DataAttribute("slot", "sheet-title"),
			h.Id(titleId(id)),
		],
		children,
	)

const linkOut = (h: H, href: string, label: string): Html =>
	linkButton(
		h,
		{
			variant: "outline",
			size: "xs",
			href,
			attributes: [h.Attribute("target", "_blank"), h.Attribute("rel", "noreferrer")],
		},
		[label, icon(h, "ExternalLinkIcon")],
	)

/** `SheetDetailHeader` with the review's kind, title, repository line and links out. */
const detailHeader = (h: H, id: string, detail: CodeReviewDetail): Html => {
	const { review } = detail
	return sheetHeader(h, [
		eyebrow(h, { as: "div", className: "flex flex-wrap items-center gap-x-2 gap-y-1" }, [
			h.span([h.Class("truncate")], ["Review"]),
			h.span([h.AriaHidden(true), h.Class("text-muted-foreground/40")], ["·"]),
			h.span([h.Class("truncate")], [`#${review.number}`]),
		]),
		sheetTitle(h, id, "flex flex-wrap items-center gap-2 text-title leading-tight", [
			h.span([h.Class("min-w-0 break-words")], [review.title ?? "Untitled pull request"]),
		]),
		h.p(
			[
				h.Class(cn(SheetStyles.sheetDescriptionStyles, "sr-only")),
				h.DataAttribute("slot", "sheet-description"),
				h.Id(descriptionId(id)),
			],
			[`Review of ${review.repositoryFullName} #${review.number}`],
		),
		h.div(
			[h.Class("flex flex-wrap items-center gap-1.5")],
			[
				h.p(
					[h.Class("w-full text-sm text-muted-foreground")],
					[
						review.repositoryFullName,
						...(review.authorLogin === null
							? []
							: [" · opened by ", authorLabel(h, review.authorLogin, "align-middle")]),
						" ",
						"· head ",
						truncatedId(h, { value: review.headSha, kind: "sha" }),
					],
				),
				h.div(
					[h.Class("flex flex-wrap gap-2 pt-1")],
					[
						linkOut(h, review.url, "Pull request"),
						...(review.commentUrl === null
							? []
							: [linkOut(h, review.commentUrl, "Summary comment")]),
						...(detail.reviewUrl === null ? [] : [linkOut(h, detail.reviewUrl, "Inline review")]),
						...(detail.checkRunUrl === null ? [] : [linkOut(h, detail.checkRunUrl, "Check run")]),
					],
				),
			],
		),
	])
}

const panel = (h: H, id: string, className: string | undefined, children: ReadonlyArray<Html>): Html =>
	DialogView.dialogPanel(h, "sheet", id, children, className)

/** `ReviewDetailBody`: skeleton until the first answer, the error with a retry, or the review. */
const body = (h: H, sheet: ReviewSheet, timeZone: string): ReadonlyArray<Html> => {
	const id = sheet.dialog.id
	if (sheet.reviewId === null) return []
	return AsyncData.matchData(sheet.detail.data, {
		onEmpty: () => [
			sheetHeader(h, [sheetTitle(h, id, undefined, [skeleton(h, "h-6 w-72")])]),
			panel(h, id, "space-y-4", [skeleton(h, "h-20 w-full"), skeleton(h, "h-40 w-full")]),
		],
		onFailure: (failure) => [
			panel(h, id, undefined, [
				errorState(h, {
					failure,
					title: "Couldn't load the review",
					onRetry: SheetMessage.ClickedRetry(),
				}),
			]),
		],
		onData: (detail) => [
			detailHeader(h, id, detail),
			panel(h, id, "flex flex-col gap-6", reviewSections(h, sheet, detail, timeZone)),
		],
	})
}

export type SheetViewInputs = Readonly<{ timeZone: string }>

/** The sheet's portal while open or closing; the page places it after its content. */
export const view = Submodel.defineView<ReviewSheet, SheetMessage, SheetViewInputs>((sheet, inputs, h) =>
	h.submodel({
		slotId: `${sheet.dialog.id}-sheet`,
		model: sheet.dialog,
		view: DialogView.view,
		viewInputs: {
			className: "w-full sm:max-w-2xl",
			side: "right",
			hasTrigger: false,
			hasDescription: AsyncData.isSuccess(sheet.detail.data),
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () => body(h, sheet, inputs.timeZone),
		},
		toParentMessage: (message) => SheetMessage.GotDialogMessage({ message }),
	}),
)
