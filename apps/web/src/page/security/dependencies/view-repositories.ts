import type { DependencyLockfileStatus, DependencyScanLockfile } from "@maple/domain/dependency-scan"
import type { DependencyScanRepository, DependencyScanSummary } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { panel, panelHeader } from "../../../ui/panel"
import { relativeTime } from "../../kit/relative-time"
import { repositoryName } from "../kit/parts"
import { isScanPending, shortSha } from "./derive"
import { Message, type Model } from "./model"

// Each connected repository: its tracked branch, the latest scan, the lockfiles it could not read
// and a Scan now button.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

/** Said when the scanner left no message of its own. */
const LOCKFILE_FALLBACK = {
	parsed: "",
	unsupported: "This lockfile format is not supported yet.",
	too_large: "Too large to scan.",
	failed: "Could not be read.",
	skipped: "Past the lockfiles a scan reads.",
} satisfies Record<DependencyLockfileStatus, string>

const LOCKFILE_STATUS_LABEL = {
	parsed: "Parsed",
	unsupported: "Unsupported",
	too_large: "Too large",
	failed: "Failed",
	skipped: "Skipped",
} satisfies Record<DependencyLockfileStatus, string>

const lockfileIssue = (h: H, lockfile: DependencyScanLockfile): Html =>
	h.li(
		[h.Key(lockfile.path), h.Class("flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs")],
		[
			h.span([h.Class("font-mono text-foreground")], [lockfile.path]),
			badge(h, { variant: lockfile.status === "failed" ? "warn" : "muted" }, [
				LOCKFILE_STATUS_LABEL[lockfile.status],
			]),
			h.span(
				[h.Class("min-w-0 text-muted-foreground")],
				[lockfile.message ?? LOCKFILE_FALLBACK[lockfile.status]],
			),
		],
	)

/** What the scan's time stands for: a failed scan read nothing, so it is not "Scanned". */
const SCAN_SUMMARY_LABEL = {
	running: "Scan started",
	completed: "Scanned",
	failed: "Last attempt",
} satisfies Record<DependencyScanSummary["status"], string>

const dot = (h: H): Html => h.span([h.AriaHidden(true), h.Class("text-foreground-faint")], ["·"])

const scanSummary = (h: H, scan: DependencyScanSummary, clock: Clock): Html =>
	h.span(
		[h.Class("flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground")],
		[
			SCAN_SUMMARY_LABEL[scan.status],
			relativeTime(h, {
				value: scan.finishedAt ?? scan.startedAt,
				nowMs: clock.nowMs,
				timeZone: clock.timeZone,
				variant: "orDate",
				tooltip: "title",
			}),
			dot(h),
			h.span([h.Class("font-mono"), h.Title(scan.commitSha)], [shortSha(scan.commitSha)]),
			dot(h),
			countLabel(scan.lockfiles.length, "lockfile"),
			dot(h),
			countLabel(scan.packageCount, "package"),
		],
	)

export const scanButton = (h: H, model: Model, repository: DependencyScanRepository): Html => {
	const isRequesting = model.requestingScans.includes(repository.id)
	const isQueued = !isRequesting && isScanPending(model, repository.id)
	const isRunning = repository.latestScan?.status === "running"
	return button(
		h,
		{
			variant: "outline",
			size: "sm",
			isLoading: isRequesting,
			isDisabled: isQueued || isRunning,
			attributes: [h.OnClick(Message.ClickedScanNow({ repositoryId: repository.id }))],
		},
		[isQueued ? "Scan queued" : isRunning ? "Scanning" : "Scan now"],
	)
}

const scanState = (h: H, scan: DependencyScanSummary | null): ReadonlyArray<Html> =>
	scan === null
		? [badge(h, { variant: "muted" }, ["Not scanned yet"])]
		: scan.status === "failed"
			? [badge(h, { variant: "crit" }, ["Scan failed"])]
			: []

const repositoryRow = (h: H, model: Model, repository: DependencyScanRepository, clock: Clock): Html => {
	const scan = repository.latestScan
	const issues = (scan?.lockfiles ?? []).filter((lockfile) => lockfile.status !== "parsed")
	return h.li(
		[h.Key(repository.id), h.Class("flex flex-col gap-2 px-4 py-3")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center justify-between gap-x-4 gap-y-2")],
				[
					h.div(
						[h.Class("flex min-w-0 flex-col gap-0.5")],
						[
							h.span(
								[h.Class("flex min-w-0 items-center gap-2")],
								[
									icon(h, "GithubIcon", {
										size: 14,
										className: "shrink-0 text-muted-foreground",
									}),
									h.a(
										[
											h.Href(repository.htmlUrl),
											h.Target("_blank"),
											h.Rel("noopener noreferrer"),
											h.Class(
												"min-w-0 text-sm font-medium hover:underline active:underline",
											),
										],
										[repositoryName(h, repository.fullName)],
									),
									h.span(
										[h.Class("shrink-0 font-mono text-xs text-muted-foreground")],
										[repository.trackedBranch],
									),
								],
							),
							scan === null
								? h.span(
										[h.Class("text-xs text-muted-foreground")],
										["Scanned on the next push, or now."],
									)
								: scanSummary(h, scan, clock),
						],
					),
					h.div(
						[h.Class("flex shrink-0 items-center gap-2")],
						[...scanState(h, scan), scanButton(h, model, repository)],
					),
				],
			),
			...(scan?.error === null || scan?.error === undefined
				? []
				: [h.p([h.Class("text-xs text-severity-error")], [scan.error])]),
			...(issues.length === 0
				? []
				: [
						h.ul(
							[h.Class("flex flex-col gap-1 pl-5.5")],
							issues.map((lockfile) => lockfileIssue(h, lockfile)),
						),
					]),
		],
	)
}

export const repositoriesPanel = (
	h: H,
	model: Model,
	repositories: ReadonlyArray<DependencyScanRepository>,
	clock: Clock,
): Html =>
	panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: "Repositories",
			action: h.span(
				[h.Class("text-xs text-muted-foreground")],
				["Tracked branch, rescanned on every push"],
			),
		}),
		h.ul(
			[h.Class("divide-y divide-border")],
			repositories.map((repository) => repositoryRow(h, model, repository, clock)),
		),
	])
