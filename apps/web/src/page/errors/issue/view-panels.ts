import type { ErrorIssueDocument, ErrorIssuePullRequestDocument } from "@maple/domain/http"
import { AlertRuleId } from "@maple/domain/primitives"
import { Option, Schema } from "effect"
import type { V2Investigation } from "@maple/domain/http/v2"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { item, itemContent, itemDescription, itemMedia } from "../../../ui/item"
import { panel, panelHeader } from "../../../ui/panel"
import { docsLink } from "../../kit/signal-empty-state"
import { Message } from "./message"
import { sectionHeading } from "../../kit/section-heading"

// `IssuePullRequestsPanel`, the attach nudge, `LinkedInvestigationPanel`, `IssueIncidentsTable`.

type H = HtmlBuilder<Message>

const IN_FLIGHT_SOFT = "bg-severity-debug-a2 text-severity-debug"

/** `PULL_REQUEST_STATE_TONE`: open is work under way; merged is done. */
const PULL_REQUEST_STATE_TONE = {
	open: IN_FLIGHT_SOFT,
	merged: TONE_SOFT.done,
	closed: TONE_SOFT.neutral,
} satisfies Record<ErrorIssuePullRequestDocument["state"], string>

const SOURCE_HINT = {
	user: null,
	agent: "attached by an agent",
	auto: "found in the pull request description",
} satisfies Record<ErrorIssuePullRequestDocument["linkSource"], string | null>

const pullRequestRow = (h: H, pr: ErrorIssuePullRequestDocument, isBusy: boolean): Html => {
	const hint = SOURCE_HINT[pr.linkSource]
	return item(h, { tag: "li", variant: "flush", size: "lg", className: "group flex-nowrap items-start" }, [
		itemMedia(h, { variant: "icon", className: "text-muted-foreground" }, [
			icon(h, "GithubIcon", { className: "size-4" }),
		]),
		itemContent(h, [
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					h.a(
						[
							h.Href(pr.url),
							h.Target("_blank"),
							h.Rel("noreferrer"),
							h.Class("truncate text-sm font-medium text-foreground hover:underline active:underline"),
						],
						[pr.repoFullName, "#", String(pr.number)],
					),
					badge(
						h,
						{
							variant: "outline",
							className: cn("shrink-0 capitalize", PULL_REQUEST_STATE_TONE[pr.state]),
						},
						[pr.state],
					),
				],
			),
			...(pr.title ? [itemDescription(h, [pr.title], "line-clamp-1")] : []),
			...(hint ? [itemDescription(h, [hint], "text-foreground-subtle")] : []),
		]),
		iconButton(
			h,
			{
				size: "icon",
				label: `Detach ${pr.repoFullName}#${pr.number}`,
				className:
					"size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
				isDisabled: isBusy,
				attributes: [h.OnClick(Message.ClickedDetachPullRequest({ id: pr.id }))],
			},
			[icon(h, "TrashIcon")],
		),
	])
}

export const pullRequestsPanel = (
	h: H,
	pullRequests: ReadonlyArray<ErrorIssuePullRequestDocument>,
	isBusy: boolean,
): Html =>
	panel(h, {}, [
		panelHeader(h, {
			title: "Pull requests",
			action: button(
				h,
				{
					size: "sm",
					variant: "ghost",
					className: "gap-1 px-2 text-xs",
					isDisabled: isBusy,
					attributes: [h.OnClick(Message.ClickedAttach())],
				},
				[icon(h, "PlusIcon"), "Attach"],
			),
		}),
		pullRequests.length === 0
			? h.div(
					[h.Class("space-y-2 px-4 py-3")],
					[
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								"Attach the pull request that fixes this. When it merges, Maple watches for the error to come back and closes this issue if it doesn't.",
							],
						),
						docsLink(h, "github", "GitHub integration docs"),
					],
				)
			: h.ul(
					[h.Class("divide-y")],
					pullRequests.map((pr) => pullRequestRow(h, pr, isBusy)),
				),
	])

/** The awaiting-fix nudge: work is under way and nothing tells Maple which fix to watch. */
export const attachNudge = (h: H): Html =>
	panel(h, { className: "px-4 py-3" }, [
		h.p(
			[h.Class("text-xs text-muted-foreground")],
			[
				"No pull request attached. Maple can only confirm this error stopped if it knows which fix to watch.",
			],
		),
		button(
			h,
			{
				size: "sm",
				variant: "outline",
				className: "mt-2 h-auto w-full whitespace-normal py-1.5 text-xs",
				attributes: [h.OnClick(Message.ClickedAttach())],
			},
			["Attach the PR that fixes this"],
		),
	])

export const linkedInvestigationPanel = (
	h: H,
	investigation: V2Investigation | null,
	isStarting: boolean,
): Html =>
	investigation === null
		? panel(
				h,
				{ className: "shrink-0 flex-row flex-wrap items-center justify-between gap-4 px-5 py-4" },
				[
					h.div(
						[h.Class("min-w-0")],
						[
							h.p(
								[h.Class("text-sm font-medium text-foreground")],
								["No linked investigation"],
							),
							h.p(
								[h.Class("mt-0.5 text-xs text-muted-foreground")],
								["Start an evidence-backed autonomous pass for this issue."],
							),
						],
					),
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isDisabled: isStarting,
							attributes: [h.OnClick(Message.ClickedInvestigate())],
						},
						[icon(h, "PulseIcon"), "Start investigation"],
					),
				],
			)
		: panel(
				h,
				{
					className:
						"grid shrink-0 gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center",
				},
				[
					h.div(
						[h.Class("min-w-0")],
						[
							h.div(
								[h.Class("flex flex-wrap items-center gap-2")],
								[
									h.p(
										[h.Class("text-sm font-medium text-foreground")],
										["Linked investigation"],
									),
									badge(h, { variant: "outline", className: "capitalize" }, [
										investigation.status,
									]),
									...(investigation.confidence
										? [
												h.span(
													[h.Class("text-xs capitalize text-muted-foreground")],
													[`${investigation.confidence} confidence`],
												),
											]
										: []),
								],
							),
							h.p(
								[h.Class("mt-1 truncate text-sm text-muted-foreground")],
								[
									investigation.report?.suspectedCause ??
										(investigation.status === "investigating"
											? "Gathering evidence…"
											: (investigation.error ?? "No diagnosis submitted")),
								],
							),
						],
					),
					linkButton(
						h,
						{
							size: "sm",
							variant: "outline",
							href: hrefOf(AppRoute.Investigation({ id: investigation.id, search: {} })),
						},
						["Open investigation"],
					),
				],
			)

/** `BodySection` over `SectionHeading`: a titled block of the page body. */
export const bodySection = (
	h: H,
	options: Readonly<{ id: string; title: string; count?: string | undefined }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.section(
		[h.AriaLabelledBy(`${options.id}-heading`), h.Class("flex shrink-0 flex-col gap-3.5")],
		[
			sectionHeading(h, { title: options.title, hint: options.count, id: `${options.id}-heading` }),
			...children,
		],
	)

const decodeRuleId = Schema.decodeUnknownOption(AlertRuleId)

/** `AlertSourceCard`: an alert-backed issue links back to the rule that feeds it. */
export const alertSourceCard = (h: H, issue: ErrorIssueDocument): Html => {
	const sourceRef = issue.sourceRef
	const ruleId = Option.getOrNull(decodeRuleId(sourceRef?.ruleId))
	const signalType = typeof sourceRef?.signalType === "string" ? sourceRef.signalType : null
	const groupKey = typeof sourceRef?.groupKey === "string" ? sourceRef.groupKey : null
	return panel(h, { className: "shrink-0 gap-2 px-5 py-4" }, [
		sectionHeading(h, { title: "Alert source" }),
		h.p(
			[h.Class("text-sm text-muted-foreground")],
			[
				"This issue is fed by alert rule incidents",
				...(signalType ? [` (${signalType})`] : []),
				...(groupKey && groupKey !== "__total__" ? [` for group "${groupKey}"`] : []),
				".",
			],
		),
		...(ruleId === null
			? []
			: [
					h.a(
						[
							h.Href(hrefOf(AppRoute.AlertRule({ ruleId, search: {} }))),
							h.Class("text-sm text-primary underline-offset-4 hover:underline active:underline"),
						],
						["View alert rule →"],
					),
				]),
	])
}
