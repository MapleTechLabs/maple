import type { ErrorIncidentDocument, ErrorIssuePullRequestDocument } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { panel, panelHeader } from "../../../ui/panel"
import { docsLink } from "../../kit/signal-empty-state"
import { Message } from "./message"
import { sectionHeading } from "../../kit/section-heading"

// `IssuePullRequestsPanel`, `LinkedInvestigationPanel`, `IssueIncidentsTable` and `BodySection`.
// TODO(attach-dialog): Attach opens `AttachPullRequestDialog` in legacy (picker and link mutation).
// TODO(pull-request-rows): linked pull requests list as rows; only the empty panel is ported.
// TODO(incident-rows): incidents render as a table in legacy; only the empty state is ported.

type H = HtmlBuilder<Message>

export const pullRequestsPanel = (h: H, pullRequests: ReadonlyArray<ErrorIssuePullRequestDocument>): Html =>
	panel(h, {}, [
		panelHeader(h, {
			title: "Pull requests",
			action: button(h, { size: "sm", variant: "ghost", className: "h-7 gap-1 px-2 text-xs" }, [
				icon(h, "PlusIcon"),
				"Attach",
			]),
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
					pullRequests.map((pr) =>
						h.li(
							[h.Class("px-4 py-3 text-sm text-foreground")],
							[`${pr.repoFullName}#${pr.number}`],
						),
					),
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
			},
			["Attach the PR that fixes this"],
		),
	])

export const linkedInvestigationPanel = (h: H, investigation: V2Investigation | null): Html =>
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
					// TODO(start-investigation): legacy creates the investigation and opens it.
					button(h, { size: "sm", variant: "outline" }, [
						icon(h, "PulseIcon"),
						"Start investigation",
					]),
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

export const incidentsTable = (h: H, incidents: ReadonlyArray<ErrorIncidentDocument>): Html =>
	incidents.length === 0
		? empty(h, [
				emptyHeader(h, [
					emptyTitle(h, ["No incidents yet"]),
					emptyDescription(h, ["Incidents open on first-seen or regression events."]),
				]),
				docsLink(h, "errors"),
			])
		: h.div([h.Class("text-sm text-muted-foreground")], [`${incidents.length} incidents`])
