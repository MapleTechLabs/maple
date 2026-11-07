import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { badge } from "@maple/views/ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { pressable } from "@maple/views/ui/pressable"
import { skeleton } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { relativeTime } from "../../kit/relative-time"
import { sectionHeading } from "../../kit/section-heading"
import { actorInitials, KIND_DOT, KIND_LABEL, type VersionRow } from "./history"
import { Message } from "./message"
import { isWriteBlocked } from "./mode"
import type { Model } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { scrollRegion } from "@maple/views/ui/scroll-region"
import { Array as Arr, String as Str } from "effect"

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
			pressable(
				h,
				{
					onClick: Message.ClickedVersion({ versionId: version.id }),
					selectedLane: isPreviewing,
					className: cn(
						"group relative w-full pl-7 pr-3 py-2.5 text-left transition-colors",
						"hover:bg-surface-sunken active:bg-surface-sunken",
					),
				},
				[
					statusDot(h, {
						tone: "custom",
						size: "lg",
						className: cn(
							"absolute left-[15px] top-[14px] ring-2 ring-background",
							KIND_DOT[version.changeKind],
						),
					}),
					hstack(h, { gap: "2", align: "start" }, [
						h.div(
							[h.Class("min-w-0 flex-1")],
							[
								hstack(h, { gap: "1.5" }, [
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
								]),
								h.div(
									[h.Class("mt-0.5 truncate text-sm leading-snug text-foreground")],
									[version.changeSummary ?? KIND_LABEL[version.changeKind]],
								),
								hstack(
									h,
									{
										gap: "1.5",
										align: "center",
										className: "mt-1 font-mono text-3xs text-muted-foreground",
									},
									[
										h.span(
											[
												h.AriaHidden(true),
												h.Class(
													"grid size-3.5 place-items-center rounded-full bg-muted text-4xs font-semibold uppercase text-muted-foreground",
												),
											],
											[Str.slice(0, 1)(actorInitials(version.createdBy))],
										),
										h.span([], ["v", String(version.versionNumber)]),
										dot(h),
										relativeTime(h, {
											value: version.createdAt,
											...clock,
										}),
									],
								),
							],
						),
					]),
				],
			),
		],
	)

const loading = (h: H): Html =>
	vstack(
		h,
		{ gap: "4", className: "px-4 py-4", attributes: [h.Role("status"), h.AriaLabel("Loading history")] },
		Arr.map([0, 1, 2, 3], () =>
			vstack(h, { gap: "1.5" }, [skeleton(h, "h-3 w-32"), skeleton(h, "h-2.5 w-48 opacity-60")]),
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
				emptyTitle(h, ["No history yet"], typographyClass({ size: "xs", weight: "medium" })),
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
					...Arr.map(versions, (version) =>
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
	return vstack(h, { className: "h-full" }, [
		hstack(h, { gap: "2", align: "center", className: "border-b px-4 py-3" }, [
			icon(h, "HistoryIcon", { className: "size-4" }),
			sectionHeading(h, { title: "History", count: String(count) }),
			iconButton(
				h,
				{
					label: "Close history panel",
					size: "icon-xs",
					className: "ml-auto text-muted-foreground hover:text-foreground active:text-foreground",
					attributes: [h.OnClick(Message.ClickedCloseHistory())],
				},
				[icon(h, "XmarkIcon")],
			),
		]),
		scrollRegion(h, {}, [
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
		]),
	])
}

const RESTORE_BLOCKED_ID = "dashboard-restore-blocked"

/** `PreviewBanner` and its restore confirmation; restore is a write, so it is off when writes are. */
export const previewBanner = (h: H, model: Model, version: VersionRow, clock: Clock): ReadonlyArray<Html> => {
	const isRestoreBlocked = isWriteBlocked(model)
	return [
		hstack(
			h,
			{
				gap: "3",
				align: "center",
				className: "mb-4 rounded-md border border-primary-a3 bg-primary-a1 px-3 py-2",
			},
			[
				icon(h, "HistoryIcon", { className: "size-4 shrink-0 text-primary" }),
				hstack(
					h,
					{
						gap: "1.5",
						align: "center",
						shrink: true,
						grow: true,
						className: "font-mono text-2xs text-foreground-soft",
					},
					[
						typography(h, { tone: "primary", weight: "semibold" }, ["PREVIEW"]),
						dot(h),
						h.span([], ["v", String(version.versionNumber)]),
						dot(h),
						relativeTime(h, { value: version.createdAt, ...clock, className: "truncate" }),
					],
				),
				hstack(h, { gap: "1.5" }, [
					...(isRestoreBlocked
						? [
								typography(
									h,
									{ size: "2xs", tone: "muted", attributes: [h.Id(RESTORE_BLOCKED_ID)] },
									["Restore is off while editing is unavailable"],
								),
							]
						: []),
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
							isDisabled: isRestoreBlocked,
							attributes: [
								h.OnClick(Message.ClickedRestoreVersion()),
								...(isRestoreBlocked ? [h.AriaDescribedBy(RESTORE_BLOCKED_ID)] : []),
							],
						},
						[
							icon(h, "ArrowPathIcon", {
								attributes: [h.DataAttribute("icon", "inline-start")],
							}),
							"Restore this version",
						],
					),
				]),
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
}
