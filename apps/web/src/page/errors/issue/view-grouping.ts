import type {
	ErrorIssueFingerprintGrouping,
	ErrorIssueGroupingResponse,
	ErrorIssueSimilarIssue,
	ErrorIssueSimilarResponse,
} from "@maple/domain/http"
import { frameFunction } from "@maple/domain/tinybird/grouping"
import { formatNumber } from "@maple/ui/lib/format"
import { Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { collapsible } from "@maple/views/ui/collapsible"
import { badge } from "@maple/views/ui/display"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { item, itemContent, itemDescription } from "@maple/views/ui/item"
import { panel } from "@maple/views/ui/panel"
import { dividedList } from "@maple/views/ui/rule"
import { skeletonList } from "@maple/views/ui/skeleton"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../../route"
import { gatedBy } from "../../kit/gated-controls"
import { WORKFLOW_LABEL } from "../../kit/issue-workflow"
import { relativeTime } from "../../kit/relative-time"
import { canTriageIssues } from "../kit/grants"
import { Message } from "./message"
import type { Model } from "./model"
import { bodySection } from "./view-panels"

// The Grouping tab: the fingerprints the issue owns, the rule that put each one here, and the
// open issues that look like it.

type H = HtmlBuilder<Message>
type Fingerprint = ErrorIssueFingerprintGrouping

const SOURCE_LABEL = {
	primary: "Own",
	merge: "Merged",
	rekey: "Re-keyed",
	group: "Grouped",
} satisfies Record<Fingerprint["source"], string>

const SOURCE_HINT = {
	primary: "The fingerprint this issue opened with",
	merge: "Moved here when another issue was merged into this one",
	rekey: "A new fingerprint for the same error after Maple changed how it fingerprints",
	group: "Joined because its grouping key matches this issue's",
} satisfies Record<Fingerprint["source"], string>

/** The grouping rule in plain words. */
export const ruleLabel = (fingerprint: Fingerprint): string => {
	switch (fingerprint.rule) {
		case null:
			return "Not keyed yet"
		case "custom":
			return "maple.fingerprint key"
		case "span":
			return "Span with no exception"
		case "org-rule":
			return `Org rule: ${fingerprint.orgRule ?? "unnamed"}`
		case "chunk-load":
			return "Chunk load failures"
		case "type-message":
			return "Same type and message"
		case "type-function": {
			const name = Arr.findFirst(fingerprint.frames, (frame) => frameFunction(frame) !== undefined)
			return name._tag === "Some"
				? `Same type, first function ${frameFunction(name.value) ?? ""}`
				: "Same type, first function"
		}
		case "frames":
			return "Generic type, keyed on frames"
	}
}

/** Enough of the hash to tell fingerprints apart; the full one is in the tooltip. */
const shortHash = (hash: string): string => (hash.length > 10 ? `${Str.slice(0, 10)(hash)}…` : hash)

const frameList = (h: H, frames: ReadonlyArray<string>, tone: "soft" | "subtle"): Html =>
	h.ol(
		[h.Class("min-w-0 space-y-0.5 overflow-x-auto")],
		Arr.map(frames, (frame, index) =>
			h.li(
				[h.Key(`${index}`)],
				[
					typography(h, { size: "xs", mono: true, tone, className: "whitespace-pre" }, [
						Str.trim(frame),
					]),
				],
			),
		),
	)

/** The server's message under the row whose split or merge failed. */
const writeError = (h: H, model: Model, target: string): ReadonlyArray<Html> =>
	model.groupingError === null || model.groupingError.target !== target
		? []
		: [
				typography(h, { size: "xs", tone: "destructive", as: "p", attributes: [h.Role("alert")] }, [
					model.groupingError.message,
				]),
			]

const splitOutButton = (h: H, model: Model, fingerprint: Fingerprint): Html =>
	gatedBy(h, canTriageIssues(model), "error_issues:triage", (isLocked) =>
		button(
			h,
			{
				size: "sm",
				variant: "outline",
				className: "shrink-0",
				isDisabled:
					isLocked ||
					(model.splittingHash !== null && model.splittingHash !== fingerprint.fingerprintHash) ||
					model.mergingIssueId !== null,
				isLoading: model.splittingHash === fingerprint.fingerprintHash,
				attributes: [
					h.Title("Open an issue of its own for this fingerprint. It is never grouped again."),
					h.OnClick(Message.ClickedSplitOut({ fingerprintHash: fingerprint.fingerprintHash })),
				],
			},
			["Split out"],
		),
	)

const fingerprintRow = (h: H, model: Model, fingerprint: Fingerprint): Html => {
	const hash = fingerprint.fingerprintHash
	const isSkippedOpen = model.openSkippedFrames.includes(hash)
	return vstack(h, { as: "li", gap: "2.5", className: "px-4 py-3", attributes: [h.Key(hash)] }, [
		hstack(h, { gap: "3", justify: "between", align: "start" }, [
			vstack(h, { gap: "1", className: "min-w-0" }, [
				typography(h, { size: "sm", weight: "medium" }, [ruleLabel(fingerprint)]),
				hstack(h, { gap: "2", wrap: true }, [
					typography(h, { size: "xs", mono: true, tone: "muted", attributes: [h.Title(hash)] }, [
						shortHash(hash),
					]),
					badge(
						h,
						{
							variant: "meta",
							size: "sm",
							attributes: [h.Title(SOURCE_HINT[fingerprint.source])],
						},
						[SOURCE_LABEL[fingerprint.source]],
					),
					...(fingerprint.pinned
						? [
								badge(
									h,
									{
										variant: "tag",
										attributes: [
											h.Title(
												"Split out or unmerged by hand, so it is never grouped again",
											),
										],
									},
									["Pinned"],
								),
							]
						: []),
				]),
			]),
			...(fingerprint.source === "group" ? [splitOutButton(h, model, fingerprint)] : []),
		]),
		...(fingerprint.messageSignature === ""
			? []
			: [
					vstack(h, { gap: "1" }, [
						eyebrow(h, {}, ["Message"]),
						typography(h, { size: "xs", mono: true, tone: "soft", className: "break-all" }, [
							fingerprint.messageSignature,
						]),
					]),
				]),
		...(fingerprint.customKey === null
			? []
			: [
					vstack(h, { gap: "1" }, [
						eyebrow(h, {}, ["maple.fingerprint"]),
						typography(h, { size: "xs", mono: true, tone: "soft", className: "break-all" }, [
							fingerprint.customKey,
						]),
					]),
				]),
		...(fingerprint.frames.length === 0
			? []
			: [
					vstack(h, { gap: "1" }, [
						eyebrow(h, {}, [fingerprint.frames.length === 1 ? "Frame read" : "Frames read"]),
						frameList(h, fingerprint.frames, "soft"),
					]),
				]),
		...(fingerprint.skippedFrames.length === 0
			? []
			: [
					collapsible(
						h,
						{
							isOpen: isSkippedOpen,
							onToggle: Message.ToggledSkippedFrames({ fingerprintHash: hash }),
							panelId: `skipped-frames-${hash}`,
							triggerClassName: `${hstackClass({ gap: "1" })} ${typographyClass({ size: "xs", tone: "muted", hoverTone: "foreground" })}`,
							panelClassName: "pt-1.5",
							trigger: [
								icon(h, isSkippedOpen ? "ChevronDownIcon" : "ChevronRightIcon", { size: 12 }),
								`${fingerprint.skippedFrames.length} skipped as library or runtime frames`,
							],
						},
						[frameList(h, fingerprint.skippedFrames, "subtle")],
					),
				]),
		...writeError(h, model, hash),
	])
}

const fingerprintsBody = (h: H, model: Model, response: ErrorIssueGroupingResponse): Html =>
	response.fingerprints.length === 0
		? emptyMessage(h, { dashed: true }, ["This issue has no fingerprints to explain yet"])
		: panel(h, { className: "shrink-0 overflow-hidden" }, [
				dividedList(
					h,
					{ as: "ul", bordered: false },
					Arr.map(response.fingerprints, (fingerprint) => fingerprintRow(h, model, fingerprint)),
				),
				...(response.truncated
					? [
							typography(
								h,
								{
									size: "xs",
									tone: "muted",
									as: "p",
									className: "border-t border-border-subtle px-4 py-2",
								},
								[`Showing the first ${response.fingerprints.length} fingerprints.`],
							),
						]
					: []),
			])

const similarityPercent = (similarity: number): string => `${Math.round(similarity * 100)}%`

const mergeButton = (h: H, model: Model, similar: ErrorIssueSimilarIssue): Html =>
	gatedBy(h, canTriageIssues(model), "error_issues:triage", (isLocked) =>
		button(
			h,
			{
				size: "sm",
				variant: "outline",
				className: "shrink-0",
				isDisabled:
					isLocked ||
					model.splittingHash !== null ||
					(model.mergingIssueId !== null && model.mergingIssueId !== similar.id),
				isLoading: model.mergingIssueId === similar.id,
				attributes: [h.OnClick(Message.ClickedMergeSimilar({ sourceIssueId: similar.id }))],
			},
			["Merge into this issue"],
		),
	)

const similarRow = (
	h: H,
	model: Model,
	similar: ErrorIssueSimilarIssue,
	clock: Readonly<{ nowMs: number; timeZone: string }>,
): Html =>
	item(
		h,
		{
			tag: "li",
			variant: "flush",
			size: "lg",
			className: "flex-wrap items-start gap-y-2 sm:flex-nowrap",
		},
		[
			itemContent(h, [
				hstack(h, { gap: "2", wrap: true }, [
					textLink(
						h,
						{
							href: hrefOf(AppRoute.ErrorIssue({ issueId: similar.id, search: {} })),
							tone: "inherit",
							className: "min-w-0",
						},
						[
							typography(
								h,
								{ size: "sm", weight: "medium", tone: "foreground", truncate: true },
								[similar.errorLabel || similar.exceptionType || "Unlabelled error"],
							),
						],
					),
					badge(
						h,
						{
							variant: "muted",
							size: "sm",
							mono: true,
							attributes: [h.Title("Share of message words in common")],
						},
						[`${similarityPercent(similar.similarity)} similar`],
					),
				]),
				...(similar.exceptionMessage === ""
					? []
					: [
							itemDescription(
								h,
								[similar.exceptionMessage],
								"line-clamp-2 break-all font-mono text-xs",
							),
						]),
				hstack(h, { gap: "1.5", wrap: true }, [
					typography(h, { size: "xs", tone: "muted", numeric: true }, [
						`${formatNumber(similar.occurrenceCount)} ${similar.occurrenceCount === 1 ? "occurrence" : "occurrences"}`,
					]),
					typography(h, { size: "xs", tone: "subtle" }, ["·"]),
					typography(h, { size: "xs", tone: "muted" }, ["last seen "]),
					relativeTime(h, {
						value: similar.lastSeenAt,
						nowMs: clock.nowMs,
						timeZone: clock.timeZone,
						className: typographyClass({ size: "xs", tone: "muted" }),
					}),
					typography(h, { size: "xs", tone: "subtle" }, ["·"]),
					typography(h, { size: "xs", tone: "muted" }, [WORKFLOW_LABEL[similar.workflowState]]),
				]),
				...writeError(h, model, similar.id),
			]),
			mergeButton(h, model, similar),
		],
	)

const similarBody = (
	h: H,
	model: Model,
	response: ErrorIssueSimilarResponse,
	clock: Readonly<{ nowMs: number; timeZone: string }>,
): Html =>
	response.issues.length === 0
		? emptyMessage(h, { dashed: true }, ["No open issues look like this one"])
		: panel(h, { className: "shrink-0 overflow-hidden" }, [
				dividedList(
					h,
					{ as: "ul", bordered: false },
					Arr.map(response.issues, (similar) => similarRow(h, model, similar, clock)),
				),
			])

const loadingRows = (h: H, label: string): Html =>
	skeletonList(h, { rows: 3, rowClassName: "h-16", gap: "2", label })

/** The Grouping tab's body: fingerprints, then similar issues, each with its own load state. */
export const groupingTab = (
	h: H,
	model: Model,
	clock: Readonly<{ nowMs: number; timeZone: string }>,
): Html => {
	const fingerprintCount = AsyncData.matchData(model.grouping.data, {
		onEmpty: () => undefined,
		onFailure: () => undefined,
		onData: (response) =>
			response.fingerprints.length === 0
				? undefined
				: `${response.fingerprints.length} ${response.fingerprints.length === 1 ? "fingerprint" : "fingerprints"}`,
	})
	return vstack(h, { gap: "8" }, [
		bodySection(h, { id: "grouping", title: "Fingerprints", count: fingerprintCount }, [
			typography(h, { size: "sm", tone: "muted", as: "p", className: "-mt-1.5" }, [
				"Each fingerprint is one throw site and message. The grouping key decides which of them are the same bug, and only ever merges them.",
			]),
			AsyncData.matchData(model.grouping.data, {
				onEmpty: () => loadingRows(h, "Loading fingerprints"),
				onFailure: (failure) =>
					errorState(h, {
						failure,
						title: "Couldn't load how this issue is grouped",
						variant: "row",
						onRetry: Message.ClickedRetryGrouping(),
					}),
				onData: (response) => fingerprintsBody(h, model, response),
			}),
		]),
		bodySection(h, { id: "similar", title: "Similar issues" }, [
			AsyncData.matchData(model.similar.data, {
				onEmpty: () => loadingRows(h, "Loading similar issues"),
				onFailure: (failure) =>
					errorState(h, {
						failure,
						title: "Couldn't load similar issues",
						variant: "row",
						onRetry: Message.ClickedRetrySimilar(),
					}),
				onData: (response) => similarBody(h, model, response, clock),
			}),
		]),
	])
}
