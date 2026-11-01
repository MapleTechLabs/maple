import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { skeleton } from "../../../ui/skeleton"
import { statusDot } from "../../../ui/status-dot"
import { relativeTime } from "../../kit/relative-time"
import { sectionHeading } from "../../kit/section-heading"
import { actorInitials, KIND_DOT, KIND_LABEL, type VersionRow } from "./history"
import { Message } from "./message"
import type { Model } from "./model"

// `DashboardHistoryPanel`, `VersionListItem` and `PreviewBanner`: the version history panel.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const dot = (h: H): Html => h.span([h.AriaHidden(true), h.Class("opacity-50")], ["·"])

const versionItem = (
	h: H,
	version: VersionRow,
	isPreviewing: boolean,
	isCurrent: boolean,
	clock: Clock,
): Html =>
	h.li(
		[h.Class("relative")],
		[
			h.button(
				[
					h.Type("button"),
					h.OnClick(Message.ClickedVersion({ versionId: version.id })),
					h.Class(
						cn(
							"group relative w-full pl-7 pr-3 py-2.5 text-left transition-colors",
							"hover:bg-surface-sunken active:bg-surface-sunken",
							rowSelectedClass(isPreviewing),
						),
					),
				],
				[
					statusDot(h, {
						tone: "custom",
						size: "lg",
						className: cn(
							"absolute left-[15px] top-[14px] ring-2 ring-background",
							KIND_DOT[version.changeKind],
						),
					}),
					h.div(
						[h.Class("flex items-start gap-2")],
						[
							h.div(
								[h.Class("min-w-0 flex-1")],
								[
									h.div(
										[h.Class("flex items-center gap-1.5")],
										[
											eyebrow(
												h,
												{
													variant: "label",
													className: isPreviewing
														? "text-primary"
														: "text-foreground-subtle group-hover:text-foreground-soft",
												},
												[KIND_LABEL[version.changeKind]],
											),
											...(isCurrent
												? [
														badge(
															h,
															{
																variant: "tag",
																className: "bg-primary-a2 text-primary",
															},
															["Current"],
														),
													]
												: []),
											...(version.isRestore
												? [
														icon(h, "ArrowPathIcon", {
															size: 10,
															className: "text-muted-foreground",
															attributes: [h.AriaLabel("restored")],
														}),
													]
												: []),
										],
									),
									h.div(
										[h.Class("mt-0.5 truncate text-sm leading-snug text-foreground")],
										[version.changeSummary ?? KIND_LABEL[version.changeKind]],
									),
									h.div(
										[
											h.Class(
												"mt-1 flex items-center gap-1.5 font-mono text-3xs text-muted-foreground",
											),
										],
										[
											h.span(
												[
													h.AriaHidden(true),
													h.Class(
														"grid size-3.5 place-items-center rounded-full bg-muted text-4xs font-semibold uppercase text-muted-foreground",
													),
												],
												[actorInitials(version.createdBy).slice(0, 1)],
											),
											h.span([], ["v", String(version.versionNumber)]),
											dot(h),
											relativeTime(h, {
												value: version.createdAt,
												...clock,
												tooltip: "title",
											}),
										],
									),
								],
							),
						],
					),
				],
			),
		],
	)

const loading = (h: H): Html =>
	h.div(
		[h.Role("status"), h.AriaLabel("Loading history"), h.Class("flex flex-col gap-4 px-4 py-4")],
		[0, 1, 2, 3].map(() =>
			h.div(
				[h.Class("flex flex-col gap-1.5")],
				[skeleton(h, "h-3 w-32"), skeleton(h, "h-2.5 w-48 opacity-60")],
			),
		),
	)

const noHistory = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { className: "mb-3 size-9 rounded-full bg-muted" }, [
					icon(h, "HistoryIcon", { size: 16, className: "text-muted-foreground" }),
				]),
				emptyTitle(h, ["No history yet"], "text-xs font-medium"),
				emptyDescription(
					h,
					["Each save is captured here so you can revisit or restore."],
					"text-2xs",
				),
			]),
		],
		"gap-0 px-4 py-12 md:py-12",
	)

const list = (h: H, model: Model, versions: ReadonlyArray<VersionRow>, clock: Clock): Html => {
	const previewed = model.history.previewed
	const latest = versions[0]?.id ?? null
	return versions.length === 0
		? noHistory(h)
		: h.ol(
				[h.Class("relative")],
				[
					h.span([h.AriaHidden(true), h.Class("absolute left-4 top-3 bottom-3 w-px bg-border")]),
					...versions.map((version) =>
						versionItem(
							h,
							version,
							previewed?.id === version.id,
							previewed === null && version.id === latest,
							clock,
						),
					),
				],
			)
}

export const historyPanel = (h: H, model: Model, clock: Clock): Html => {
	const versions = model.history.versions
	const count = AsyncData.getOrElse(versions, () => []).length
	return h.div(
		[h.Class("flex h-full flex-col")],
		[
			h.div(
				[h.Class("flex items-center gap-2 border-b px-4 py-3")],
				[
					icon(h, "HistoryIcon", { className: "size-4" }),
					sectionHeading(h, { title: "History", count: String(count) }),
					iconButton(
						h,
						{
							label: "Close history panel",
							size: "icon-xs",
							className:
								"ml-auto text-muted-foreground hover:text-foreground active:text-foreground",
							attributes: [h.OnClick(Message.ClickedCloseHistory())],
						},
						[icon(h, "XmarkIcon")],
					),
				],
			),
			h.div(
				[h.Class("flex-1 min-h-0 overflow-y-auto")],
				[
					AsyncData.match(versions, {
						onIdle: () => loading(h),
						onLoading: () => loading(h),
						onFailure: (failure) =>
							errorState(h, {
								failure,
								variant: "inline",
								title: "Couldn't load history",
								className: "px-4",
							}),
						onSuccess: (rows) => list(h, model, rows, clock),
						onRefreshing: (rows) => list(h, model, rows, clock),
						onStale: ({ data }) => list(h, model, data, clock),
					}),
				],
			),
		],
	)
}

/** `PreviewBanner` and its restore confirmation. */
export const previewBanner = (h: H, model: Model, version: VersionRow, clock: Clock): ReadonlyArray<Html> => [
	h.div(
		[h.Class("mb-4 flex items-center gap-3 rounded-md border border-primary-a3 bg-primary-a1 px-3 py-2")],
		[
			icon(h, "HistoryIcon", { className: "size-4 shrink-0 text-primary" }),
			h.div(
				[h.Class("flex min-w-0 flex-1 items-center gap-1.5 font-mono text-2xs text-foreground-soft")],
				[
					h.span([h.Class("font-semibold text-primary")], ["PREVIEW"]),
					dot(h),
					h.span([], ["v", String(version.versionNumber)]),
					dot(h),
					relativeTime(h, { value: version.createdAt, ...clock, className: "truncate" }),
				],
			),
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					button(
						h,
						{
							variant: "ghost",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedCancelPreview())],
						},
						["Cancel"],
					),
					button(
						h,
						{
							variant: "default",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedRestoreVersion())],
						},
						[
							icon(h, "ArrowPathIcon", {
								attributes: [h.DataAttribute("icon", "inline-start")],
							}),
							"Restore this version",
						],
					),
				],
			),
		],
	),
	confirmDialog(h, {
		slotId: "dashboard-restore-version",
		model: model.history.restoreDialog,
		toParentMessage: (message) => Message.GotRestoreDialogMessage({ message }),
		tone: "default",
		hasIcon: false,
		title: `Restore version v${version.versionNumber}?`,
		description:
			"The current dashboard will be replaced with this version. The current state will be saved as a new history entry, so this is undoable.",
		confirmLabel: "Restore",
		isPending: model.history.isRestoring,
		onConfirm: Message.ConfirmedRestore(),
	}),
]
