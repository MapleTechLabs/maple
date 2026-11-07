import type { GithubIntegrationStatus, GithubRepoSummary, VcsRepoSyncStatus } from "@maple/domain/http"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { revealIcon } from "@maple/views/ui/reveal-icon"
import type { Html, HtmlBuilder } from "foldkit/html"
import { listRow } from "@maple/views/ui/list-row"
import { heading } from "@maple/views/ui/heading"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { badge } from "@maple/views/ui/display"
import { icon, type IconName } from "@maple/views/ui/icon"
import { item, itemContent, itemMedia } from "@maple/views/ui/item"
import { panel, panelHeader } from "@maple/views/ui/panel"
import * as Popover from "@maple/views/ui/popover"
import { searchInput } from "@maple/views/ui/search-input"
import { spinner } from "@maple/views/ui/spinner"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { relativeTime } from "../kit/relative-time"
import { branchPopoverId } from "./github"
import { Message } from "./message"
import type { Model } from "./model"
import { githubStatusOf, trackedBranchOf } from "./update-github"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str, Option } from "effect"
import { dividedList } from "@maple/views/ui/rule"
import { textLink } from "@maple/views/ui/text-link"

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
	hstack(h, { gap: "2" }, [
		textLink(
			h,
			{
				href: repo.htmlUrl,
				tone: "inherit",
				className: "group max-w-full truncate text-sm font-medium",
				attributes: [h.Target("_blank"), h.Rel("noreferrer")],
			},
			[
				typography(h, { truncate: true, attributes: [h.Title(repo.fullName)] }, [repo.fullName]),
				revealIcon(h, "ExternalLinkIcon", { size: 12 }),
			],
		),
		...(repo.isPrivate
			? [badge(h, { variant: "outline", size: "sm", className: "shrink-0" }, ["Private"])]
			: []),
	])

const branchContent = (h: H, model: Model, repo: GithubRepoSummary): ReadonlyArray<Html> => {
	const query = model.githubCard.branchRepo === repo.id ? model.githubCard.branchQuery : ""
	const tracked = trackedBranchOf(model, repo)
	const filtered =
		query === ""
			? repo.branches
			: Arr.filter(repo.branches, (branch) =>
					Str.includes(Str.toLowerCase(query))(Str.toLowerCase(branch.name)),
				)
	return [
		h.div(
			[h.Class("border-b px-3 py-2.5")],
			[
				typography(h, { size: "xs", tone: "foreground", weight: "medium", as: "p" }, [
					"Tracked branch",
				]),
				typography(h, { size: "xs", tone: "muted", as: "p", className: "mt-0.5" }, [
					"Maple syncs commits from the one branch you track. Changing it re-syncs this repo's commits from the new branch.",
				]),
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
				? [
						typography(h, { size: "xs", tone: "muted", as: "p", className: "px-2 py-1.5" }, [
							"No matches.",
						]),
					]
				: Arr.map(filtered, (branch) =>
						listRow(h, {
							onClick: Message.ClickedBranch({ repoId: repo.id, branch: branch.name }),
							density: "compact",
							className: "cursor-pointer gap-2 rounded-md px-2",
							leading: icon(h, "CheckIcon", {
								size: 14,
								className: branch.name === tracked ? "text-foreground" : "text-transparent",
							}),
							title: branch.name,
							trailing: branch.isDefault
								? badge(h, { variant: "outline", size: "sm" }, ["default"])
								: undefined,
						}),
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
				hstack(h, { gap: "1.5", align: "center", className: "text-xs" }, [
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
									typography(h, { tone: "muted" }, [
										"· ",
										relativeTime(h, {
											value: repo.lastSyncedAt,
											nowMs: model.nowMs,
											timeZone,
										}),
									]),
								]
							: []),
				]),
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
	hstack(h, { gap: "1", as: "span" }, [glyph, String(count), ` ${label}`])

const removedRow = (h: H, model: Model, repo: GithubRepoSummary): Html =>
	item(h, { variant: "flush", size: "lg", tag: "li" }, [
		itemMedia(h, {}, [icon(h, "CircleWarningIcon", { size: 16, className: "text-severity-warn" })]),
		itemContent(
			h,
			[
				repoLink(h, repo),
				typography(h, { size: "xs", tone: "muted", as: "div" }, [
					"Access removed on GitHub · commit history kept",
				]),
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
	const active = Arr.filter(status.repositories, (repo) => repo.status === "active")
	const removed = Arr.filter(status.repositories, (repo) => repo.status === "removed")
	const synced = Arr.filter(active, (repo) => repo.syncStatus === "ready").length
	const syncing = Arr.filter(
		active,
		(repo) => repo.syncStatus === "pending" || repo.syncStatus === "backfilling",
	).length
	const failed = Arr.filter(active, (repo) => repo.syncStatus === "error").length
	const discovery = status.repositoryDiscovery
	const counts = hstack(h, { gap: "3", className: typographyClass({ size: "xs", tone: "muted" }) }, [
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
	])
	// A discovery in flight or failed sits above repositories already synced, never in their place.
	const discoveryNotice: ReadonlyArray<Html> =
		discovery?._tag === "Pending"
			? [
					hstack(
						h,
						{ gap: "2.5", align: "center", className: "px-4 py-6 text-sm text-muted-foreground" },
						[spinner(h, undefined, 16), "Discovering repositories…"],
					),
				]
			: discovery?._tag === "Failed"
				? [
						vstack(h, { gap: "3", align: "start", className: "px-4 py-6 text-sm" }, [
							typography(h, { tone: "destructive", as: "p" }, [discovery.message]),
							button(
								h,
								{
									variant: "outline",
									isDisabled: model.connect.isStarting,
									attributes: [h.OnClick(Message.ClickedConnect())],
								},
								["Reconnect GitHub"],
							),
						]),
					]
				: []
	return [
		panel(h, {}, [
			panelHeader(h, {
				children: [
					heading(h, { level: 3, variant: "subsection" }, [
						"Repositories",
						h.span([h.Class("ml-1.5 text-muted-foreground")], [String(active.length)]),
					]),
				],
				action: active.length > 0 ? counts : undefined,
			}),
			...discoveryNotice,
			...(active.length > 0
				? [
						dividedList(
							h,
							{ as: "ul", bordered: false },
							Arr.map(active, (repo) => repoRow(h, model, repo, timeZone)),
						),
					]
				: discoveryNotice.length === 0 && removed.length === 0
					? [
							h.p(
								[h.Class("px-4 py-6 text-sm text-muted-foreground")],
								[
									"No repositories granted. Change repository access on GitHub to grant Maple at least one.",
								],
							),
						]
					: []),
		]),
		...(removed.length > 0
			? [
					panel(h, {}, [
						panelHeader(h, {
							children: [
								heading(
									h,
									{
										level: 3,
										variant: "subsection",
										className: hstackClass({ gap: "1.5" }),
									},
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
						dividedList(
							h,
							{ as: "ul", bordered: false },
							Arr.map(removed, (repo) => removedRow(h, model, repo)),
						),
						h.p(
							[h.Class("border-t px-4 py-2.5 text-xs text-muted-foreground")],
							[
								"Re-enable these in the",
								" ",
								textLink(
									h,
									{
										href: "https://github.com/settings/installations",
										tone: "inherit",
										className:
											"inline font-medium underline hover:text-foreground active:text-foreground",
										attributes: [h.Target("_blank"), h.Rel("noreferrer")],
									},
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
	const repoName = (repoId: string | null | undefined) =>
		Option.getOrElse(
			Option.map(
				Arr.findFirst(status?.repositories ?? [], (repo) => repo.id === repoId),
				(repo) => repo.fullName,
			),
			() => "",
		)
	const pending = model.githubCard.pendingBranch

	const strong = (text: string) => typography(h, { tone: "foreground", weight: "medium" }, [text])
	return [
		confirmDialog(h, {
			slotId: "github-repo-delete",
			model: model.githubCard.deleteDialog,
			toParentMessage: (message) => Message.GotRepoDeleteDialogMessage({ message }),
			title: "Delete repository from Maple?",
			description: [
				"This permanently removes",
				" ",
				strong(repoName(model.githubCard.repoToDelete)),
				" and all of its synced commits from Maple. This cannot be undone. If you re-enable access in GitHub later, the repository will be re-synced from scratch.",
			],
			confirmLabel: "Delete repository",
			isPending: model.githubCard.deletingRepo !== null,
			onConfirm: Message.ConfirmedRepoDelete(),
		}),
		confirmDialog(h, {
			slotId: "github-branch-change",
			model: model.githubCard.branchDialog,
			toParentMessage: (message) => Message.GotBranchDialogMessage({ message }),
			title: "Change tracked branch?",
			description: [
				"This switches ",
				strong(repoName(pending?.repoId)),
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
			isPending:
				pending !== null &&
				Arr.some(model.githubCard.savingBranches, (entry) => entry.repoId === pending.repoId),
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
	const saving = Arr.some(model.githubCard.savingBranches, (entry) => entry.repoId === repo.id)
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
								typography(h, { tone: "muted" }, ["branch"]),
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
