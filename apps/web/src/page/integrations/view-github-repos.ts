import type { GithubIntegrationStatus, GithubRepoSummary, VcsRepoSyncStatus } from "@maple/domain/http"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { confirmDialog } from "../../ui/confirm-dialog"
import { badge } from "../../ui/display"
import { icon, type IconName } from "../../ui/icon"
import { item, itemContent, itemMedia } from "../../ui/item"
import { panel, panelHeader } from "../../ui/panel"
import * as Popover from "../../ui/popover"
import { searchInput } from "../../ui/search-input"
import { spinner } from "../../ui/spinner"
import { truncatedText } from "../../ui/truncated-text"
import { relativeTime } from "../kit/relative-time"
import { branchPopoverId } from "./github"
import { Message } from "./message"
import type { Model } from "./model"
import { githubStatusOf, trackedBranchOf } from "./update-github"

// `ConnectedView`'s repository panels, `RepoRow` and `BranchSelector`.

type H = HtmlBuilder<Message>

export const SYNC_PRESENTATION = {
	ready: { label: "Synced", tone: "text-severity-info", icon: "CircleCheckIcon", spin: false },
	backfilling: { label: "Syncing", tone: "text-severity-info", icon: "LoaderIcon", spin: true },
	pending: { label: "Queued", tone: "text-muted-foreground", icon: "ClockIcon", spin: false },
	error: { label: "Sync failed", tone: "text-severity-error", icon: "CircleWarningIcon", spin: false },
} satisfies {
	readonly [K in VcsRepoSyncStatus]: { label: string; tone: string; icon: IconName; spin?: boolean }
}

const repoLink = (h: H, repo: GithubRepoSummary): Html =>
	h.div(
		[h.Class("flex items-center gap-2")],
		[
			h.a(
				[
					h.Href(repo.htmlUrl),
					h.Target("_blank"),
					h.Rel("noreferrer"),
					h.Class(
						"group inline-flex max-w-full items-center gap-1 truncate text-sm font-medium hover:underline",
					),
				],
				[
					h.span([h.Class("truncate"), h.Title(repo.fullName)], [repo.fullName]),
					icon(h, "ExternalLinkIcon", {
						size: 12,
						className:
							"shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
					}),
				],
			),
			...(repo.isPrivate
				? [badge(h, { variant: "outline", size: "sm", className: "shrink-0" }, ["Private"])]
				: []),
		],
	)

const branchContent = (h: H, model: Model, repo: GithubRepoSummary): ReadonlyArray<Html> => {
	const query = model.githubCard.branchRepo === repo.id ? model.githubCard.branchQuery : ""
	const tracked = trackedBranchOf(model, repo)
	const filtered =
		query === ""
			? repo.branches
			: repo.branches.filter((branch) => branch.name.toLowerCase().includes(query.toLowerCase()))
	return [
		h.div(
			[h.Class("border-b px-3 py-2.5")],
			[
				h.p([h.Class("text-xs font-medium text-foreground")], ["Tracked branch"]),
				h.p(
					[h.Class("mt-0.5 text-xs text-muted-foreground")],
					[
						"Maple syncs commits from the one branch you track. Changing it re-syncs this repo's commits from the new branch.",
					],
				),
			],
		),
		...(repo.branches.length > 8
			? [
					h.div(
						[h.Class("border-b p-2")],
						[
							searchInput(h, {
								id: `${branchPopoverId(repo.id)}-search`,
								value: query,
								placeholder: "Search branches…",
								onInput: (value) => Message.ChangedBranchQuery({ value }),
								onClear: Message.ChangedBranchQuery({ value: "" }),
							}),
						],
					),
				]
			: []),
		h.div(
			[h.Class("max-h-56 overflow-y-auto p-1")],
			filtered.length === 0
				? [h.p([h.Class("px-2 py-1.5 text-xs text-muted-foreground")], ["No matches."])]
				: filtered.map((branch) =>
						h.button(
							[
								h.Type("button"),
								h.OnClick(Message.ClickedBranch({ repoId: repo.id, branch: branch.name })),
								h.Class(
									"flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-sunken",
								),
							],
							[
								icon(h, "CheckIcon", {
									size: 14,
									className: `shrink-0 ${branch.name === tracked ? "text-foreground" : "text-transparent"}`,
								}),
								h.span([h.Class("truncate")], [branch.name]),
								...(branch.isDefault
									? [
											badge(
												h,
												{ variant: "outline", size: "sm", className: "ml-auto" },
												["default"],
											),
										]
									: []),
							],
						),
					),
		),
	]
}

const repoRow = (h: H, model: Model, repo: GithubRepoSummary, timeZone: string): Html => {
	const presentation = SYNC_PRESENTATION[repo.syncStatus]
	return item(h, { variant: "flush", size: "lg", tag: "li" }, [
		itemMedia(h, {}, [
			icon(h, presentation.icon, {
				size: 16,
				className: `${presentation.tone} ${presentation.spin === true ? "animate-spin" : ""}`,
			}),
		]),
		itemContent(
			h,
			[
				repoLink(h, repo),
				h.div(
					[h.Class("flex items-center gap-1.5 text-xs")],
					[
						h.span([h.Class(presentation.tone)], [presentation.label]),
						...(repo.syncStatus === "error" &&
						repo.lastSyncError !== null &&
						repo.lastSyncError !== ""
							? [
									truncatedText(
										h,
										{ text: repo.lastSyncError, className: "text-muted-foreground" },
										["· ", repo.lastSyncError],
									),
								]
							: repo.lastSyncedAt !== null && repo.lastSyncedAt !== 0
								? [
										h.span(
											[h.Class("text-muted-foreground")],
											[
												"· ",
												relativeTime(h, {
													value: repo.lastSyncedAt,
													nowMs: model.nowMs,
													timeZone,
												}),
											],
										),
									]
								: []),
					],
				),
			],
			"gap-0",
		),
		...(repo.prReviewEnabled
			? [
					badge(
						h,
						{
							variant: "outline",
							size: "sm",
							className: "shrink-0",
							attributes: [h.Title("Maple reviews this repository's pull requests")],
						},
						["Reviewed"],
					),
				]
			: []),
		branchSelector(h, model, repo),
	])
}

const syncCount = (h: H, glyph: Html, count: number, label: string): Html =>
	h.span([h.Class("flex items-center gap-1")], [glyph, String(count), ` ${label}`])

const removedRow = (h: H, model: Model, repo: GithubRepoSummary): Html =>
	item(h, { variant: "flush", size: "lg", tag: "li" }, [
		itemMedia(h, {}, [icon(h, "CircleWarningIcon", { size: 16, className: "text-severity-warn" })]),
		itemContent(
			h,
			[
				repoLink(h, repo),
				h.div(
					[h.Class("text-xs text-muted-foreground")],
					["Access removed on GitHub · commit history kept"],
				),
			],
			"gap-0",
		),
		button(
			h,
			{
				size: "sm",
				variant: "destructive-outline",
				className: "shrink-0",
				isDisabled: model.githubCard.deletingRepo !== null,
				isLoading: model.githubCard.deletingRepo === repo.id,
				attributes: [h.OnClick(Message.ClickedRepoDelete({ repoId: repo.id }))],
			},
			[icon(h, "TrashIcon"), "Delete"],
		),
	])

export const repositoriesPanels = (
	h: H,
	model: Model,
	status: GithubIntegrationStatus,
	timeZone: string,
): ReadonlyArray<Html> => {
	const active = status.repositories.filter((repo) => repo.status === "active")
	const removed = status.repositories.filter((repo) => repo.status === "removed")
	const synced = active.filter((repo) => repo.syncStatus === "ready").length
	const syncing = active.filter(
		(repo) => repo.syncStatus === "pending" || repo.syncStatus === "backfilling",
	).length
	const failed = active.filter((repo) => repo.syncStatus === "error").length
	const discovery = status.repositoryDiscovery
	const counts = h.div(
		[h.Class("flex items-center gap-3 text-xs text-muted-foreground")],
		[
			...(synced > 0
				? [
						syncCount(
							h,
							icon(h, "CircleCheckIcon", { size: 14, className: "text-severity-info" }),
							synced,
							"synced",
						),
					]
				: []),
			...(syncing > 0 ? [syncCount(h, spinner(h, "text-severity-info", 13), syncing, "syncing")] : []),
			...(failed > 0
				? [
						syncCount(
							h,
							icon(h, "CircleWarningIcon", { size: 14, className: "text-severity-error" }),
							failed,
							"failed",
						),
					]
				: []),
		],
	)
	return [
		panel(h, {}, [
			panelHeader(h, {
				children: [
					h.h3(
						[h.Class("text-sm font-medium")],
						[
							"Repositories",
							h.span([h.Class("ml-1.5 text-muted-foreground")], [String(active.length)]),
						],
					),
				],
				action: active.length > 0 ? counts : undefined,
			}),
			discovery?._tag === "Pending"
				? h.div(
						[h.Class("flex items-center gap-2.5 px-4 py-6 text-sm text-muted-foreground")],
						[spinner(h, undefined, 16), "Discovering repositories…"],
					)
				: discovery?._tag === "Failed"
					? h.div(
							[h.Class("flex flex-col items-start gap-3 px-4 py-6 text-sm")],
							[
								h.p([h.Class("text-severity-error")], [discovery.message]),
								button(
									h,
									{
										variant: "outline",
										isDisabled: model.connect.isStarting,
										attributes: [h.OnClick(Message.ClickedConnectExistingGithub())],
									},
									["Connect existing installation"],
								),
							],
						)
					: active.length === 0 && removed.length === 0
						? h.p(
								[h.Class("px-4 py-6 text-sm text-muted-foreground")],
								[
									"No repositories granted. Change repository access on GitHub to grant Maple at least one.",
								],
							)
						: h.ul(
								[h.Class("divide-y")],
								active.map((repo) => repoRow(h, model, repo, timeZone)),
							),
		]),
		...(removed.length > 0
			? [
					panel(h, {}, [
						panelHeader(h, {
							children: [
								h.h3(
									[h.Class("flex items-center gap-1.5 text-sm font-medium")],
									[
										icon(h, "CircleWarningIcon", {
											size: 16,
											className: "text-severity-warn",
										}),
										"Needs attention",
									],
								),
							],
						}),
						h.ul(
							[h.Class("divide-y")],
							removed.map((repo) => removedRow(h, model, repo)),
						),
						h.p(
							[h.Class("border-t px-4 py-2.5 text-xs text-muted-foreground")],
							[
								"Re-enable these in the",
								" ",
								h.a(
									[
										h.Href("https://github.com/settings/installations"),
										h.Target("_blank"),
										h.Rel("noreferrer"),
										h.Class(
											"font-medium underline underline-offset-2 hover:text-foreground",
										),
									],
									["Maple GitHub App"],
								),
								" ",
								"to resume syncing. Deleting removes their synced commits permanently.",
							],
						),
					]),
				]
			: []),
	]
}

/** The repository-delete and branch-change confirmations. */
export const repoDialogs = (h: H, model: Model): ReadonlyArray<Html> => {
	const status = githubStatusOf(model)
	const toDelete = status?.repositories.find((repo) => repo.id === model.githubCard.repoToDelete)
	const pending = model.githubCard.pendingBranch
	const pendingRepo = status?.repositories.find((repo) => repo.id === pending?.repoId)
	const strong = (text: string) => h.span([h.Class("font-medium text-foreground")], [text])
	return [
		confirmDialog(h, {
			slotId: "github-repo-delete",
			model: model.githubCard.deleteDialog,
			toParentMessage: (message) => Message.GotRepoDeleteDialogMessage({ message }),
			title: "Delete repository from Maple",
			description: [
				"This permanently removes",
				" ",
				strong(toDelete?.fullName ?? ""),
				" and all of its synced commits from Maple. This cannot be undone. If you re-enable access in GitHub later, the repository will be re-synced from scratch.",
			],
			confirmLabel: "Delete",
			onConfirm: Message.ConfirmedRepoDelete(),
		}),
		confirmDialog(h, {
			slotId: "github-branch-change",
			model: model.githubCard.branchDialog,
			toParentMessage: (message) => Message.GotBranchDialogMessage({ message }),
			title: "Change tracked branch",
			description: [
				"This switches ",
				strong(pendingRepo?.fullName ?? ""),
				" to track ",
				strong(pending?.branch ?? ""),
				". Maple deletes this repo's currently synced commits and re-syncs the last 90 days from",
				" ",
				strong(pending?.branch ?? ""),
				".",
			],
			confirmLabel: "Track branch",
			tone: "default",
			hasIcon: false,
			onConfirm: Message.ConfirmedBranch(),
		}),
	]
}

const branchSelector = (h: H, model: Model, repo: GithubRepoSummary): Html => {
	if (repo.branches.length === 0) return h.empty
	const popover =
		model.githubCard.branchRepo === repo.id
			? model.githubCard.branchPopover
			: Popover.init(branchPopoverId(repo.id), { align: "end" })
	const saving = model.githubCard.savingBranches.some((entry) => entry.repoId === repo.id)
	return h.submodel({
		slotId: branchPopoverId(repo.id),
		model: popover,
		view: Popover.view,
		toParentMessage: (message: Popover.Message) =>
			Message.GotBranchPopoverMessage({ repoId: repo.id, message }),
		viewInputs: {
			className: "w-72 p-0",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								className: "h-7 shrink-0 gap-1.5 px-2.5 font-normal",
								isLoading: saving,
								slot: "popover-trigger",
								attributes: [
									...trigger,
									...(popover.isOpen ? [h.DataAttribute("pressed", "")] : []),
								],
							},
							[
								h.span([h.Class("text-muted-foreground")], ["branch"]),
								h.span(
									[h.Class("max-w-[10rem] truncate font-medium")],
									[trackedBranchOf(model, repo) ?? EMPTY_VALUE],
								),
								icon(h, "ChevronDownIcon", { className: "text-muted-foreground" }),
							],
						),
					),
				),
			toContent: () => branchContent(h, model, repo),
		},
	})
}
