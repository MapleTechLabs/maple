import type { GithubIntegrationStatus, GithubRepoSummary } from "@maple/domain/http"
import { countLabel, EMPTY_VALUE } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { badge } from "../../ui/display"
import { icon } from "../../ui/icon"
import { meter } from "../../ui/meter"
import { columnHead, dataTable, dataTableEmpty } from "../infra/kit/data-table"
import {
	type CheckRow,
	flowColumns,
	flowRail,
	foundChips,
	liveChecklist,
	savedBanner,
	statusRow,
	stepCard,
} from "../kit/connect-flow"
import { catalogEntry } from "./catalog"
import type { FlowStage } from "./flow"
import { activeRepos, githubReach } from "./flow-github"
import { Message } from "./message"
import type { Model } from "./model"
import { githubStatusOf } from "./update-github"
import { githubDeactivated, githubInstallationPicker, githubReconnectButton } from "./view-github"
import { SYNC_PRESENTATION } from "./view-github-repos"

// GitHub in the connect flow: install the Maple GitHub App, then watch the repositories sync.

type H = HtmlBuilder<Message>

const DOCS_HREF = catalogEntry("github").docsUrl

const ACCOUNT_TYPE = { organization: "Organization", user: "Personal account" } as const

const readsRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "What Maple reads",
		items: [
			{
				icon: "RocketIcon",
				title: "Deploy markers",
				detail: "Metric shifts line up with the deploys that caused them",
			},
			{
				icon: "BranchForkIcon",
				title: "Commit context",
				detail: "Commit SHAs on traces resolve to message, author and a GitHub link",
			},
			{
				icon: "PullRequestIcon",
				title: "Pull request reviews",
				detail: "Maple comments on pull requests with what changed in production",
			},
			{
				icon: "SquareTerminalIcon",
				title: "CI traces and logs",
				detail: "Each GitHub Actions run becomes a trace",
			},
		],
		trust: "Maple never pushes code. Uninstall the app from GitHub settings at any time; commit history already synced stays in Maple.",
		timeNote: "Takes about 1 minute",
		docs: DOCS_HREF === undefined ? null : { label: "GitHub setup docs", href: DOCS_HREF },
	})

const showsUpRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "Where it shows up",
		items: [
			{
				icon: "ChartLineIcon",
				title: "Service charts",
				detail: "Deploys to the tracked branch as markers",
			},
			{ icon: "LayersIcon", title: "Traces", detail: "Spans with a commit SHA link to GitHub" },
			{ icon: "PullRequestIcon", title: "Code Review", detail: "Rules, models and analytics" },
			{ icon: "GearIcon", title: "Source page", detail: "Edit data, tracked branches, Disconnect" },
		],
		trust: "Large repos can take a few minutes to backfill. Nothing here needs you to stay.",
		docs: DOCS_HREF === undefined ? null : { label: "Docs", href: DOCS_HREF },
	})

const installButton = (
	h: H,
	model: Model,
	label: string,
	variant?: "outline",
	onClick: Message = Message.ClickedConnect(),
): Html =>
	button(
		h,
		{
			size: variant === undefined ? undefined : "sm",
			variant,
			className: "w-fit",
			isDisabled: model.connect.isStarting || model.githubCard.selectingInstallation !== null,
			isLoading: model.connect.isStarting,
			attributes: [h.OnClick(onClick)],
		},
		variant === undefined ? [icon(h, "GithubIcon"), label] : [label],
	)

/** The installation: where it lives, how much it can read, and the way to change it on GitHub. */
const installation = (h: H, model: Model, status: GithubIntegrationStatus): Html => {
	const repos = activeRepos(status)
	return h.div(
		[h.Class("flex flex-col gap-3")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-3 rounded-md border border-border p-3")],
				[
					icon(h, "GithubIcon", { size: 18, className: "shrink-0" }),
					h.div(
						[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
						[
							h.span(
								[h.Class("flex items-center gap-2 text-sm font-medium")],
								[
									status.accountLogin ?? "GitHub App",
									...(status.accountType === null
										? []
										: [
												badge(h, { variant: "outline", size: "sm" }, [
													ACCOUNT_TYPE[status.accountType],
												]),
											]),
								],
							),
							h.span(
								[h.Class("text-xs text-muted-foreground")],
								[
									status.repositorySelection === "selected"
										? "Selected repositories"
										: "All repositories",
									", ",
									`${repos.length} granted`,
								],
							),
						],
					),
					installButton(
						h,
						model,
						"Change repos on GitHub",
						"outline",
						Message.ClickedOpenGithubInstallPage(),
					),
				],
			),
			...(repos.length === 0
				? []
				: [
						foundChips(
							h,
							repos.map((repo) => ({ label: repo.fullName })),
						),
					]),
		],
	)
}

const connectStep = (h: H, model: Model): Html => {
	const status = githubStatusOf(model)
	const isConnected = status !== null && status.connected
	const isDeactivated = status !== null && (status.state === "suspended" || status.state === "disconnected")
	const isWaiting = model.connect.active !== null && !isConnected
	const hasSelection = model.githubCard.selection !== null
	const discovery = status?.repositoryDiscovery
	const isDiscovering = discovery?._tag === "Pending"
	return flowColumns(
		h,
		[
			isDeactivated && !hasSelection && !isDiscovering && discovery?._tag !== "Failed"
				? githubDeactivated(h, model, status)
				: stepCard(
						h,
						{ icon: "GithubIcon", title: "Connect the Maple GitHub App" },
						hasSelection
							? githubInstallationPicker(h, model)
							: isDiscovering
								? [
										h.p(
											[h.Class("text-sm text-muted-foreground")],
											[
												"Maple is reading the repositories granted to this installation.",
											],
										),
									]
								: isConnected
									? [installation(h, model, status)]
									: discovery?._tag === "Failed"
										? [
												h.p(
													[h.Class("text-sm text-muted-foreground")],
													["Reconnect to retry repository discovery."],
												),
											]
										: [
												h.p(
													[h.Class("text-sm text-muted-foreground")],
													[
														"GitHub opens in a new window. Approve Maple, then pick an account where the app is installed, or install it and choose All repositories or Selected repositories. Maple reads code metadata, deployments and checks, and writes pull request comments.",
													],
												),
												installButton(h, model, "Connect GitHub"),
											],
					),
			hasSelection
				? statusRow(h, { tone: "idle", text: "Choose an account to finish connecting." })
				: isDiscovering
					? statusRow(h, { tone: "working", text: "Discovering repositories…" })
					: discovery?._tag === "Failed" && !hasSelection
						? statusRow(h, { tone: "error", text: discovery.message })
						: isWaiting
							? statusRow(h, { tone: "working", text: "Waiting for GitHub to send you back…" })
							: isConnected
								? statusRow(h, {
										tone: "ok",
										text: `${githubReach(status)} with ${countLabel(activeRepos(status).length, "repository", "repositories")}.`,
									})
								: isDeactivated
									? statusRow(h, {
											tone: "error",
											text: "The app lost access on GitHub. Reconnect to pick up where sync stopped.",
										})
									: statusRow(h, {
											tone: "idle",
											text: "Not connected yet. This step completes on its own when GitHub sends you back.",
										}),
			...(discovery?._tag === "Failed" && !hasSelection ? [githubReconnectButton(h, model)] : []),
		],
		readsRail(h),
	)
}

const syncRow = (
	h: H,
	repos: ReadonlyArray<GithubRepoSummary>,
	discovery: GithubIntegrationStatus["repositoryDiscovery"],
): CheckRow => {
	if (discovery?._tag === "Pending")
		return {
			state: "working",
			title: "Discovering repositories",
			detail: "Maple is reading the repositories granted to this installation.",
		}
	if (discovery?._tag === "Failed")
		return { state: "failed", title: "Repository discovery failed", detail: discovery.message }
	const total = repos.length
	const synced = repos.filter((repo) => repo.syncStatus === "ready").length
	const failed = repos.filter((repo) => repo.syncStatus === "error")
	const syncing = repos.filter((repo) => repo.syncStatus === "backfilling").length
	if (total === 0)
		return {
			state: "failed",
			title: "No repositories granted",
			detail: "Change repos on GitHub to grant Maple at least one.",
		}
	if (failed.length > 0)
		return {
			state: "failed",
			title: "Repositories synced",
			detail: `${synced} synced, ${countLabel(failed.length, "sync")} failed: ${failed[0]?.lastSyncError ?? "unknown error"}`,
		}
	if (synced < total)
		return {
			state: "working",
			title: "Repositories syncing",
			detail: `${synced} synced, ${syncing} syncing, ${total - synced - syncing} queued. Commit history backfills in the background.`,
			extra: meter(h, {
				value: synced,
				max: total,
				label: "Repositories synced",
				className: "mt-1 max-w-sm",
			}),
		}
	return { state: "done", title: "Repositories synced", detail: `${synced} of ${total} synced` }
}

const accessRow = (status: GithubIntegrationStatus, repos: number): CheckRow =>
	status.connected
		? {
				state: "done",
				title: "Access works",
				detail: `The Maple GitHub App can read ${countLabel(repos, "repository", "repositories")}${status.accountLogin === null ? "" : ` on ${status.accountLogin}`}`,
			}
		: {
				state: "failed",
				title: "Access lost",
				detail:
					status.state === "suspended"
						? "GitHub suspended the Maple GitHub App. Reconnect to resume."
						: "The Maple GitHub App was uninstalled on GitHub. Reconnect to resume.",
			}

const repoTable = (h: H, repos: ReadonlyArray<GithubRepoSummary>): Html =>
	dataTable(
		h,
		{ ariaLabel: "GitHub repositories" },
		[
			columnHead(h, { label: "Repository", width: "w-0 min-w-48 flex-1" }),
			columnHead(h, { label: "Tracked branch", width: "w-36" }),
			columnHead(h, { label: "Status", width: "w-28", align: "right" }),
		],
		repos.length === 0
			? [dataTableEmpty(h, ["No repositories granted yet."])]
			: repos.map((repo) => {
					const presentation = SYNC_PRESENTATION[repo.syncStatus]
					return h.div(
						[
							h.Class(
								"flex items-center gap-4 border-b border-border-subtle px-4 py-2.5 text-sm last:border-0",
							),
						],
						[
							h.span([h.Class("w-0 min-w-48 flex-1 truncate")], [repo.fullName]),
							h.span(
								[h.Class("w-36 shrink-0 truncate font-mono text-xs text-muted-foreground")],
								[repo.trackedBranch ?? EMPTY_VALUE],
							),
							h.span(
								[
									h.Class(
										cn(
											"inline-flex w-28 shrink-0 items-center justify-end gap-1 text-xs",
											presentation.tone,
										),
									),
								],
								[
									icon(h, presentation.icon, {
										size: 12,
										className: presentation.spin ? "animate-spin" : undefined,
									}),
									presentation.label,
								],
							),
						],
					)
				}),
	)

const liveStep = (h: H, model: Model): Html => {
	const status = githubStatusOf(model)
	const repos = status === null ? [] : activeRepos(status)
	const discovery = status?.repositoryDiscovery
	const isDiscovering = discovery?._tag === "Pending"
	const discoveryFailed = discovery?._tag === "Failed"
	const isLive =
		status !== null &&
		status.connected &&
		!isDiscovering &&
		!discoveryFailed &&
		repos.length > 0 &&
		repos.every((repo) => repo.syncStatus === "ready")
	return flowColumns(
		h,
		[
			savedBanner(
				h,
				"Saved as a source. Safe to leave; sync keeps running.",
				"Nothing to apply on GitHub",
			),
			liveChecklist(h, {
				title: isLive ? "GitHub is live" : "Going live",
				rows:
					status === null
						? [{ state: "waiting", title: "Waiting for GitHub's status" }]
						: isDiscovering || discoveryFailed
							? [syncRow(h, repos, status.repositoryDiscovery)]
							: [
									accessRow(status, repos.length),
									syncRow(h, repos, status.repositoryDiscovery),
								],
			}),
			...(discoveryFailed
				? [githubReconnectButton(h, model)]
				: status !== null && !status.connected && !isDiscovering
					? [installButton(h, model, "Reconnect GitHub")]
					: []),
			...(repos.length > 0 || (!isDiscovering && !discoveryFailed) ? [repoTable(h, repos)] : []),
		],
		showsUpRail(h),
	)
}

export const githubFlowView = (h: H, model: Model, stage: FlowStage): Html =>
	stage === "live" ? liveStep(h, model) : connectStep(h, model)
