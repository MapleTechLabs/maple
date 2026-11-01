import { errorRateLevel } from "@maple/ui/lib/error-rate"
import { countLabel, formatErrorRate, formatNumber, pluralize } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { skeletonListGapStyles, skeletonListStyles } from "@maple/ui/styles/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { IssueSeverity } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { inlineCode } from "../../../ui/inline-code"
import { docsLink } from "../../kit/signal-empty-state"
import { emptyMessage } from "../../../ui/empty"
import { listRow } from "../../../ui/list-row"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { textLink } from "../../../ui/text-link"
import { truncatedText } from "../../../ui/truncated-text"
import { type DeployEntry, deriveDeploys, firstLine, isResolvableSha } from "./derive-panels"
import { Message } from "./message"
import type { Issue, Model } from "./model"
import { DEPLOYS_EXPANDED, DEPLOYS_RAIL } from "./update"
import { sectionCard } from "./view-panels"
import { relativeTime } from "../../kit/relative-time"
import { severityBadge } from "../../errors/kit/severity"

// `ServiceErrorsPanel` + `IssueLine`, and `ServiceRecentDeploys` (components/services/).

type H = HtmlBuilder<Message>

export type Clock = Readonly<{ nowMs: number; timeZone: string }>

const isIssueSeverity = Schema.is(IssueSeverity)

const issueSeverityBadge = (h: H, severity: string | null): Html =>
	severityBadge(
		h,
		severity !== null && isIssueSeverity(severity) ? severity : null,
		"w-[60px] justify-center",
	)

const issueLine = (h: H, issue: Issue, clock: Clock): Html =>
	listRow(h, {
		density: "compact",
		className: "gap-2.5 rounded-sm px-2 text-sm",
		href: `/errors/issues/${issue.id}`,
		leading: issueSeverityBadge(h, issue.severity),
		title: truncatedText(h, { text: issue.title, className: "font-normal" }),
		trailing: h.span(
			[h.Class("contents")],
			[
				h.span(
					[h.Class("font-mono text-xs tabular-nums text-muted-foreground")],
					[formatNumber(issue.occurrenceCount), "×"],
				),
				relativeTime(h, {
					value: issue.lastSeenAt,
					...clock,
					variant: "orDate",
					mono: true,
					tooltip: "title",
					className: "w-14 text-right text-xs text-foreground-subtle",
				}),
			],
		),
	})

const issuesFrame = (h: H, isLimited: boolean, children: ReadonlyArray<Html>): Html =>
	sectionCard(
		h,
		{
			title: "Open issues",
			action: h.div(
				[h.Class("flex items-center gap-3")],
				[
					...(isLimited
						? [h.span([h.Class("text-2xs text-muted-foreground")], ["Latest 90 days"])]
						: []),
					textLink(h, { href: "/errors", className: "text-xs" }, ["View all →"]),
				],
			),
		},
		children,
	)

/** `ServiceErrorsPanel`: skeleton, the "Couldn't load" line, or up to five issue rows. */
export const issuesPanel = (h: H, model: Model, clock: Clock, isLimited: boolean): Html =>
	AsyncData.match(model.issues.data, {
		onIdle: () => issuesFrame(h, false, [skeletonList(h, { rows: 4, className: "p-2" })]),
		onLoading: () => issuesFrame(h, false, [skeletonList(h, { rows: 4, className: "p-2" })]),
		onFailure: () => issuesFrame(h, false, [emptyMessage(h, {}, ["Couldn't load issues."])]),
		onStale: () => issuesFrame(h, false, [emptyMessage(h, {}, ["Couldn't load issues."])]),
		onRefreshing: (issues) => issuesReady(h, issues, clock, isLimited),
		onSuccess: (issues) => issuesReady(h, issues, clock, isLimited),
	})

const issuesReady = (h: H, issues: ReadonlyArray<Issue>, clock: Clock, isLimited: boolean): Html =>
	issuesFrame(h, isLimited, [
		issues.length === 0
			? emptyMessage(h, {}, ["No open issues for this service"])
			: h.div(
					[h.Class("space-y-px p-2")],
					issues.map((issue) => issueLine(h, issue, clock)),
				),
	])

/** `ErrorRateChip`: the version's window-wide error rate, shown even at ~0%. */
const errorRateChip = (h: H, deploy: DeployEntry): Html => {
	if (deploy.spanCount <= 0) return null
	const ratio = deploy.errorCount / deploy.spanCount
	const level = errorRateLevel(ratio)
	return badge(
		h,
		{
			size: "xs",
			mono: true,
			className: cn(
				"cursor-default",
				level === "neutral" ? "bg-transparent text-foreground-subtle" : TONE_SOFT[level],
			),
			attributes: [
				h.Title(
					`${formatNumber(deploy.errorCount)} errors of ${formatNumber(deploy.spanCount)} spans while this version served traffic`,
				),
			],
		},
		[formatErrorRate(ratio)],
	)
}

/** `RowFrame`: avatar · [line1 + chip / line2]. */
const rowFrame = (h: H, avatar: Html, line1: Html, chip: Html, line2: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("flex items-start gap-2.5 rounded-sm px-2 py-1.5")],
		[
			h.div([h.Class("mt-0.5 shrink-0")], [avatar]),
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-0.5 leading-tight")],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[h.div([h.Class("min-w-0 flex-1 truncate text-ui")], [line1]), chip],
					),
					h.div([h.Class("flex items-baseline gap-1.5 text-2xs text-muted-foreground")], line2),
				],
			),
		],
	)

const rowMeta = (
	h: H,
	deploy: DeployEntry,
	clock: Clock,
	prefix: ReadonlyArray<Html>,
): ReadonlyArray<Html> => [
	...prefix,
	h.span([h.Class("shrink-0 tabular-nums")], [formatNumber(deploy.spanCount), " spans"]),
	relativeTime(h, {
		value: deploy.firstSeen,
		...clock,
		variant: "orDate",
		mono: true,
		tooltip: "title",
		className: "ml-auto shrink-0 cursor-default text-foreground-subtle",
	}),
]

const blankAvatar = (h: H): Html => h.span([h.Class("block size-5 rounded-full bg-muted")])

const deploysEmpty = (h: H): Html =>
	emptyMessage(h, { className: "flex flex-col items-center gap-1" }, [
		h.span([], ["No deploys detected in this window."]),
		h.span(
			[h.Class("text-foreground-subtle")],
			[
				"Deploy tracking needs spans to carry the",
				" ",
				inlineCode(h, {}, ["vcs.ref.head.revision"]),
				" resource attribute.",
			],
		),
		h.span([h.Class("mt-1")], [docsLink(h, "github")]),
	])

/** `ConnectRepoFooter`: one CTA when the first resolvable sha failed as "not connected". */
const connectRepoFooter = (h: H, model: Model, deploys: ReadonlyArray<DeployEntry>): ReadonlyArray<Html> => {
	const first = deploys.find((deploy) => isResolvableSha(deploy.sha))
	const commit = first === undefined ? undefined : model.commits[first.sha]
	const isNotConnected =
		commit !== undefined &&
		AsyncData.isFailure(commit) &&
		commit.error.tag.endsWith("IntegrationsNotConnectedError")
	return isNotConnected
		? [
				h.div(
					[h.Class("border-t px-4 py-2 text-xs")],
					[
						textLink(h, { href: "/sources/new?integration=github" }, [
							"Connect a repository to resolve commits",
							h.span([h.AriaHidden(true)], ["→"]),
						]),
					],
				),
			]
		: []
}

/** `ServiceRecentDeploys`: newest first, eight rows until expanded (fifty at most). */
export const deploysPanel = (h: H, model: Model, clock: Clock, isLoading: boolean): Html => {
	if (isLoading) {
		return sectionCard(h, { title: "Recent deploys" }, [
			h.div(
				[
					h.AriaBusy(true),
					h.Class(cn(skeletonListStyles, skeletonListGapStyles.px, "p-2")),
					h.DataAttribute("slot", "skeleton-list"),
				],
				Array.from({ length: 4 }, () => deploySkeleton(h)),
			),
		])
	}
	const releases = AsyncData.getOrElse(
		AsyncData.map(model.overview.data, (data) => data.releases),
		() => [],
	)
	const deploys = deriveDeploys(releases)
	const isExpanded = model.isDeploysExpanded
	const visible = deploys.slice(0, isExpanded ? DEPLOYS_EXPANDED : DEPLOYS_RAIL)
	const hiddenCount = deploys.length - visible.length
	return sectionCard(
		h,
		{
			title: "Recent deploys",
			action:
				deploys.length === 0
					? undefined
					: h.span(
							[h.Class("text-xs text-foreground-subtle")],
							[countLabel(deploys.length, "version"), " in window"],
						),
		},
		deploys.length === 0
			? [deploysEmpty(h)]
			: [
					h.div(
						[h.Class(cn("space-y-px p-2", isExpanded && "max-h-96 overflow-y-auto"))],
						[
							...visible.map((deploy) => deployRow(h, model, deploy, clock)),
							...(isExpanded && hiddenCount > 0
								? [
										h.div(
											[
												h.Class(
													"px-2 py-1.5 text-center text-2xs text-foreground-subtle",
												),
											],
											[
												`…and ${hiddenCount} more ${pluralize(hiddenCount, "version")} in this window`,
											],
										),
									]
								: []),
						],
					),
					...(deploys.length > DEPLOYS_RAIL
						? [
								h.div(
									[h.Class("border-t p-1")],
									[
										button(
											h,
											{
												variant: "ghost",
												size: "sm",
												className:
													"w-full text-xs text-muted-foreground hover:text-foreground active:text-foreground",
												attributes: [h.OnClick(Message.ClickedToggleDeploys())],
											},
											[
												isExpanded
													? "Show fewer"
													: deploys.length <= DEPLOYS_EXPANDED
														? `Show all ${deploys.length} deploys`
														: `Show latest ${DEPLOYS_EXPANDED} deploys`,
											],
										),
									],
								),
							]
						: []),
					...connectRepoFooter(h, model, deploys),
				],
	)
}

/** `shortReleaseLabel`: a full sha shortened, any other reference verbatim. */
const shortReleaseLabel = (sha: string): string => (isResolvableSha(sha) ? shortId(sha, "sha") : sha)

/** `CommitAvatar compact`. TODO(avatar-error): a broken avatar URL does not fall back to initials. */
const commitAvatar = (h: H, url: string | null, name: string): Html =>
	url === null
		? h.div(
				[
					h.Class(
						"size-5 flex shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium uppercase text-muted-foreground",
					),
				],
				[name.slice(0, 2)],
			)
		: h.img([
				h.Src(url),
				h.Alt(""),
				h.Class("size-5 shrink-0 rounded-full ring-1 ring-foreground/10"),
				h.Attribute("loading", "lazy"),
				h.Attribute("referrerpolicy", "no-referrer"),
			])

/** `CommitShaHoverCard`'s trigger. TODO(commit-hover-card): the card itself is not ported. */
const commitTrigger = (h: H, className: string, label: string): Html =>
	h.span([h.Class(cn("cursor-default", className)), h.DataAttribute("slot", "hover-card-trigger")], [label])

const deploySkeleton = (h: H): Html =>
	h.div(
		[h.Class("flex items-start gap-2.5 px-2 py-1.5")],
		[
			skeleton(h, "mt-0.5 size-5 shrink-0 rounded-full"),
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-1")],
				[skeleton(h, "h-3.5 w-3/4"), skeleton(h, "h-3 w-1/2")],
			),
		],
	)

const deployRow = (h: H, model: Model, deploy: DeployEntry, clock: Clock): Html => {
	const chip = errorRateChip(h, deploy)
	if (!isResolvableSha(deploy.sha)) {
		const label = shortId(deploy.sha, "generic", { length: 24, ellipsis: true })
		return rowFrame(
			h,
			blankAvatar(h),
			h.span([h.Class("font-mono text-xs text-foreground")], [label]),
			chip,
			rowMeta(h, deploy, clock, [h.span([h.Class("shrink-0")], ["deployment reference"])]),
		)
	}
	const fallback = () =>
		rowFrame(
			h,
			blankAvatar(h),
			commitTrigger(h, "font-mono text-xs text-foreground", shortReleaseLabel(deploy.sha)),
			chip,
			rowMeta(h, deploy, clock, [h.span([h.Class("shrink-0")], ["commit unresolved"])]),
		)
	return AsyncData.match(model.commits[deploy.sha] ?? AsyncData.Loading(), {
		onIdle: () => deploySkeleton(h),
		onLoading: () => deploySkeleton(h),
		onFailure: fallback,
		onStale: fallback,
		onRefreshing: (commit) => resolvedRow(h, deploy, commit, chip, clock),
		onSuccess: (commit) => resolvedRow(h, deploy, commit, chip, clock),
	})
}

const resolvedRow = (
	h: H,
	deploy: DeployEntry,
	commit: Readonly<{
		message: string
		authorLogin: string | null
		authorName: string | null
		authorAvatarUrl: string | null
	}>,
	chip: Html,
	clock: Clock,
): Html => {
	const author = commit.authorLogin ?? commit.authorName ?? "Unknown author"
	const subject = firstLine(commit.message)
	return rowFrame(
		h,
		commitAvatar(h, commit.authorAvatarUrl, author),
		commitTrigger(h, "text-foreground", subject === "" ? shortReleaseLabel(deploy.sha) : subject),
		chip,
		rowMeta(h, deploy, clock, [
			h.span([h.Class("min-w-0 truncate")], [author]),
			h.span(
				[h.Class("font-mono tabular-nums shrink-0"), h.Title(deploy.sha)],
				[shortId(deploy.sha, "sha")],
			),
		]),
	)
}
