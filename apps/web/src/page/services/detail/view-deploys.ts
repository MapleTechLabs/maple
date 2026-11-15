import { PANEL_ROW_CLASS } from "./view-panels"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { countLabel, formatNumber, pluralize } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import { IssueSeverity } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import { Schema, Array as Arr, String as Str, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { inlineCode } from "@maple/views/ui/inline-code"
import { docsLink } from "../../kit/signal-empty-state"
import { emptyMessage } from "@maple/views/ui/empty"
import { listRow } from "@maple/views/ui/list-row"
import { pressable } from "@maple/views/ui/pressable"
import { skeleton, skeletonList } from "@maple/views/ui/skeleton"
import { textLink } from "@maple/views/ui/text-link"
import { truncatedText } from "@maple/views/ui/truncated-text"
import {
	type DeployCheck,
	deployBefore,
	deployChecksOf,
	deployDataEndOf,
	isOpenDeploy,
	railOrder,
} from "./derive-deploys"
import { verdictBadge, verdictFigure } from "./view-verdict"
import { Message } from "./message"
import type { Issue, Model } from "./model"
import { DEPLOYS_EXPANDED, DEPLOYS_RAIL } from "./update"
import { sectionCard } from "./view-panels"
import { relativeTime } from "../../kit/relative-time"
import { severityBadge } from "../../kit/issue-severity"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { commitAvatar, firstLine, isResolvableSha } from "../../kit/commit-card"

type H = HtmlBuilder<Message>

export type Clock = Readonly<{ nowMs: number; timeZone: string }>

const isIssueSeverity = Schema.is(IssueSeverity)

const issueSeverityBadge = (h: H, severity: string | null): Html =>
	severityBadge(
		h,
		severity !== null && isIssueSeverity(severity) ? severity : null,
		"w-[60px] justify-center",
	)

/** "new since 9b2f0d1": the window's deploy an issue first appeared after. */
const newSinceTag = (h: H, deploy: DeployCheck | undefined): ReadonlyArray<Html> =>
	deploy === undefined
		? []
		: [
				typography(
					h,
					{
						size: "2xs",
						tone: "subtle",
						// Phones keep the room for the title.
						className: "hidden shrink-0 sm:inline",
						attributes: [h.Title(`First seen after ${deploy.sha} deployed`)],
					},
					["new since ", typography(h, { mono: true }, [shortReleaseLabel(deploy.sha)])],
				),
			]

const issueLine = (
	h: H,
	issue: Issue,
	clock: Clock,
	hasSeverity: boolean,
	deploys: ReadonlyArray<DeployCheck>,
	dataEndMs: number,
): Html =>
	listRow(h, {
		density: "compact",
		className: PANEL_ROW_CLASS,
		href: `/errors/issues/${issue.id}`,
		leading: hasSeverity ? issueSeverityBadge(h, issue.severity) : undefined,
		title: truncatedText(h, { text: issue.title, className: "font-normal" }),
		trailing: h.span(
			[h.Class("contents")],
			[
				...newSinceTag(
					h,
					deployBefore(deploys, parseWarehouseDateTime(issue.firstSeenAt), dataEndMs),
				),
				typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
					formatNumber(issue.occurrenceCount),
					"×",
				]),
				relativeTime(h, {
					value: issue.lastSeenAt,
					...clock,
					variant: "orDate",
					mono: true,
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
			action: hstack(h, { gap: "3" }, [
				...(isLimited ? [typography(h, { size: "2xs", tone: "muted" }, ["Latest 90 days"])] : []),
				textLink(h, { href: "/errors", className: "text-xs" }, ["View all →"]),
			]),
		},
		children,
	)

/** Skeleton, the "Couldn't load" line, or up to five issue rows. */
export const issuesPanel = (
	h: H,
	model: Model,
	clock: Clock,
	isLimited: boolean,
	deploys: ReadonlyArray<DeployCheck>,
): Html =>
	AsyncData.match(model.issues.data, {
		onIdle: () => issuesFrame(h, false, [skeletonList(h, { rows: 4, className: "p-2" })]),
		onLoading: () => issuesFrame(h, false, [skeletonList(h, { rows: 4, className: "p-2" })]),
		onFailure: () => issuesFrame(h, false, [emptyMessage(h, {}, ["Couldn't load issues"])]),
		onStale: () => issuesFrame(h, false, [emptyMessage(h, {}, ["Couldn't load issues"])]),
		onRefreshing: (issues) => issuesReady(h, issues, clock, isLimited, deploys, deployDataEndOf(model)),
		onSuccess: (issues) => issuesReady(h, issues, clock, isLimited, deploys, deployDataEndOf(model)),
	})

const issuesReady = (
	h: H,
	issues: ReadonlyArray<Issue>,
	clock: Clock,
	isLimited: boolean,
	deploys: ReadonlyArray<DeployCheck>,
	dataEndMs: number,
): Html => {
	const hasSeverity = Arr.some(issues, (issue) => issue.severity !== null)
	return issuesFrame(h, isLimited, [
		issues.length === 0
			? emptyMessage(h, {}, ["No open issues for this service"])
			: h.div(
					[h.Class("space-y-px p-2")],
					Arr.map(issues, (issue) => issueLine(h, issue, clock, hasSeverity, deploys, dataEndMs)),
				),
	])
}

/** Avatar · [line1 + chip / line2]. */
const rowFrame = (h: H, avatar: Html, line1: Html, chip: Html, line2: ReadonlyArray<Html>): Html =>
	hstack(h, { gap: "2.5", align: "start", className: "rounded-sm px-2 py-1.5" }, [
		h.div([h.Class("mt-0.5 shrink-0")], [avatar]),
		vstack(h, { gap: "0.5", shrink: true, grow: true, className: "leading-tight" }, [
			hstack(h, { gap: "2" }, [h.div([h.Class("min-w-0 flex-1 truncate text-ui")], [line1]), chip]),
			hstack(h, { gap: "1.5", align: "baseline", className: "text-2xs text-muted-foreground" }, line2),
		]),
	])

const rowMeta = (
	h: H,
	deploy: DeployCheck,
	clock: Clock,
	prefix: ReadonlyArray<Html>,
	showEnvironment: boolean,
): ReadonlyArray<Html> => {
	const figure = verdictFigure(deploy)
	return [
		...prefix,
		...(showEnvironment && deploy.environment !== ""
			? [typography(h, { className: "shrink-0" }, [deploy.environment])]
			: []),
		...(figure === undefined
			? []
			: [typography(h, { mono: true, numeric: true, className: "shrink-0" }, [figure])]),
		relativeTime(h, {
			value: deploy.firstSeenMs,
			...clock,
			variant: "orDate",
			mono: true,
			className: "ml-auto shrink-0 cursor-default text-foreground-subtle",
		}),
	]
}

const blankAvatar = (h: H): Html => h.span([h.Class("block size-5 rounded-full bg-muted")])

/** A service that reports versions just shipped nothing new; one that reports none gets the setup hint. */
const deploysEmpty = (h: H, model: Model): Html => {
	// Only a settled overview with no versions earns the setup hint; until it answers, stay neutral.
	const hasNoVersions = AsyncData.getOrElse(
		AsyncData.map(model.overview.data, (overview) => overview.releases.length === 0),
		() => false,
	)
	if (!hasNoVersions) return emptyMessage(h, {}, ["No new version deployed in this window"])
	return emptyMessage(h, { className: "flex flex-col items-center gap-1" }, [
		h.span([], ["No deploys detected in this window"]),
		typography(h, { tone: "subtle" }, [
			"Deploy tracking needs spans to carry the",
			" ",
			inlineCode(h, {}, ["vcs.ref.head.revision"]),
			" resource attribute.",
		]),
		h.span([h.Class("mt-1")], [docsLink(h, "github")]),
	])
}

/** One CTA when the first resolvable sha failed as "not connected". */
const connectRepoFooter = (h: H, model: Model, deploys: ReadonlyArray<DeployCheck>): ReadonlyArray<Html> => {
	const commit = Option.match(
		Arr.findFirst(deploys, (deploy) => isResolvableSha(deploy.sha)),
		{ onNone: () => undefined, onSome: (first) => model.commits[first.sha] },
	)
	const isNotConnected =
		commit !== undefined &&
		AsyncData.isFailure(commit) &&
		Str.endsWith("IntegrationsNotConnectedError")(commit.error.tag)
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

const deploysFrame = (h: H, action: Html | undefined, children: ReadonlyArray<Html>): Html =>
	sectionCard(h, { title: "Recent deploys", action }, children)

/** Flagged first, then newest; eight rows until expanded (fifty at most). */
export const deploysPanel = (h: H, model: Model, clock: Clock): Html =>
	AsyncData.match(model.deploys.data, {
		onIdle: () => deploysLoading(h),
		onLoading: () => deploysLoading(h),
		onFailure: () => deploysFrame(h, undefined, [emptyMessage(h, {}, ["Couldn't load deploys"])]),
		onStale: () => deploysFrame(h, undefined, [emptyMessage(h, {}, ["Couldn't load deploys"])]),
		onRefreshing: () => deploysReady(h, model, clock),
		onSuccess: () => deploysReady(h, model, clock),
	})

const deploysLoading = (h: H): Html =>
	deploysFrame(h, undefined, [
		skeletonList(h, { rows: 4, className: "p-2", renderRow: () => deploySkeleton(h) }),
	])

const deploysReady = (h: H, model: Model, clock: Clock): Html => {
	const deploys = railOrder(deployChecksOf(model))
	const showEnvironment = new Set(Arr.map(deploys, (deploy) => deploy.environment)).size > 1
	const isExpanded = model.isDeploysExpanded
	const visible = deploys.slice(0, isExpanded ? DEPLOYS_EXPANDED : DEPLOYS_RAIL)
	const hiddenCount = deploys.length - visible.length
	return deploysFrame(
		h,
		deploys.length === 0
			? undefined
			: typography(h, { size: "xs", tone: "subtle" }, [
					countLabel(deploys.length, "deploy"),
					" in this window",
				]),
		deploys.length === 0
			? [deploysEmpty(h, model)]
			: [
					h.div(
						[h.Class(cn("space-y-px p-2", isExpanded && "max-h-96 overflow-y-auto"))],
						[
							...Arr.map(visible, (deploy) =>
								deployRow(h, model, deploy, clock, showEnvironment),
							),
							...(isExpanded && hiddenCount > 0
								? [
										h.div(
											[
												h.Class(
													"px-2 py-1.5 text-center text-2xs text-foreground-subtle",
												),
											],
											[
												`…and ${hiddenCount} more ${pluralize(hiddenCount, "deploy")} in this window`,
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

/** The commit hover card's trigger. TODO(commit-hover-card): the card itself is not ported. */
const commitTrigger = (h: H, className: string, label: string): Html =>
	h.span([h.Class(cn("cursor-default", className)), h.DataAttribute("slot", "hover-card-trigger")], [label])

const deploySkeleton = (h: H): Html =>
	hstack(h, { gap: "2.5", align: "start", className: "px-2 py-1.5" }, [
		skeleton(h, "mt-0.5 size-5 shrink-0 rounded-full"),
		vstack(h, { gap: "1", shrink: true, grow: true }, [
			skeleton(h, "h-3.5 w-3/4"),
			skeleton(h, "h-3 w-1/2"),
		]),
	])

/** A row opens the deploy's drawer; the open one keeps its lane. */
const deployRow = (h: H, model: Model, deploy: DeployCheck, clock: Clock, showEnvironment: boolean): Html =>
	pressable(
		h,
		{
			onClick: Message.ClickedDeploy({ sha: deploy.sha, environment: deploy.environment }),
			selectedLane: isOpenDeploy(model.search, deploy),
			className: "block w-full rounded-sm text-left hover:bg-surface-sunken active:bg-surface-sunken",
			attributes: [h.Key(`${deploy.sha}-${deploy.environment}`)],
		},
		[deployRowContent(h, model, deploy, clock, showEnvironment)],
	)

const deployRowContent = (
	h: H,
	model: Model,
	deploy: DeployCheck,
	clock: Clock,
	showEnvironment: boolean,
): Html => {
	const chip = verdictBadge(h, deploy)
	if (!isResolvableSha(deploy.sha)) {
		const label = shortId(deploy.sha, "generic", { length: 24, ellipsis: true })
		return rowFrame(
			h,
			blankAvatar(h),
			typography(h, { size: "xs", tone: "foreground", mono: true }, [label]),
			chip,
			rowMeta(
				h,
				deploy,
				clock,
				[h.span([h.Class("shrink-0")], ["deployment reference"])],
				showEnvironment,
			),
		)
	}
	const fallback = () =>
		rowFrame(
			h,
			blankAvatar(h),
			commitTrigger(h, "font-mono text-xs text-foreground", shortReleaseLabel(deploy.sha)),
			chip,
			rowMeta(
				h,
				deploy,
				clock,
				[h.span([h.Class("shrink-0")], ["commit unresolved"])],
				showEnvironment,
			),
		)
	return AsyncData.match(model.commits[deploy.sha] ?? AsyncData.Loading(), {
		onIdle: () => deploySkeleton(h),
		onLoading: () => deploySkeleton(h),
		onFailure: fallback,
		onStale: fallback,
		onRefreshing: (commit) => resolvedRow(h, deploy, commit, chip, clock, showEnvironment),
		onSuccess: (commit) => resolvedRow(h, deploy, commit, chip, clock, showEnvironment),
	})
}

const resolvedRow = (
	h: H,
	deploy: DeployCheck,
	commit: Readonly<{
		message: string
		authorLogin: string | null
		authorName: string | null
		authorAvatarUrl: string | null
	}>,
	chip: Html,
	clock: Clock,
	showEnvironment: boolean,
): Html => {
	const author = commit.authorLogin ?? commit.authorName ?? "Unknown author"
	const subject = firstLine(commit.message)
	return rowFrame(
		h,
		commitAvatar(h, commit.authorAvatarUrl, author),
		commitTrigger(h, "text-foreground", subject === "" ? shortReleaseLabel(deploy.sha) : subject),
		chip,
		rowMeta(
			h,
			deploy,
			clock,
			[
				typography(h, { truncate: true, className: "min-w-0" }, [author]),
				typography(
					h,
					{ mono: true, numeric: true, className: "shrink-0", attributes: [h.Title(deploy.sha)] },
					[shortId(deploy.sha, "sha")],
				),
			],
			showEnvironment,
		),
	)
}
