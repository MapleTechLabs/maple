import type {
	SecurityAuditFinding,
	SecurityAuditFindingTriageStatus,
	SecurityAuditTarget,
} from "@maple/domain/http"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import type { SecurityAuditRunId } from "@maple/domain/security-audit"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { LoadFailure } from "../../../data/load-failure"
import type { BreadcrumbEntry } from "../../../shell"
import { button } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import { copyButton } from "../../../ui/copy-button"
import { detailRailGroup, detailRailRow } from "../../../ui/detail-rail"
import { badge } from "../../../ui/display"
import * as Field from "../../../ui/field"
import { errorState } from "../../../ui/error-state"
import * as ToggleGroup from "../../../ui/toggle-group"
import { textarea } from "../../../ui/textarea"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailTitle, detailTitleSkeleton } from "../../kit/detail-header"
import { relativeTime } from "../../kit/relative-time"
import { resourceNotFound } from "../../kit/resource-not-found"
import {
	FINDING_STATUS_LABEL,
	gateOf,
	SECURITY_SEVERITY_LABEL,
	shortId,
	refLabel,
	VERDICT_LABEL,
} from "../kit/format"
import { codeCrumbs, stack } from "../kit/layout"
import { gateState, metaItem, placeholder, securitySeverityBadge } from "../kit/parts"
import { currentTriageOf, findingOf, pickedTriageOf, reasonErrorOf, targetOf } from "./derive"
import { Message, type Model } from "./model"
import { findingBody } from "../kit/finding-body"
import { findingBadge } from "../kit/findings-view"

// `/security/code/findings/$targetId/$fingerprint`: the record on the left, triage and facts on the right.

type H = HtmlBuilder<Message>

const TRIAGE_OPTIONS: ReadonlyArray<{ value: SecurityAuditFindingTriageStatus; label: string }> = [
	{ value: "open", label: "Open" },
	{ value: "dismissed", label: "Dismiss" },
	{ value: "accepted_risk", label: "Accept risk" },
]

const runHref = (runId: SecurityAuditRunId) => hrefOf(AppRoute.SecurityRun({ runId }))

const headerBadges = (h: H, finding: SecurityAuditFinding): ReadonlyArray<Html> => {
	return [
		...(finding.overallSeverity !== null
			? [securitySeverityBadge(h, finding.overallSeverity)]
			: finding.estimatedSeverity !== null
				? [findingBadge(h, finding)]
				: []),
		badge(
			h,
			{
				variant:
					finding.verdict === "confirmed"
						? "ok"
						: finding.verdict === "rejected"
							? "muted"
							: "outline",
			},
			[VERDICT_LABEL[finding.verdict]],
		),
		badge(h, { variant: "meta" }, [FINDING_STATUS_LABEL[finding.status]]),
	]
}

const title = (
	h: H,
	model: Model,
	finding: SecurityAuditFinding,
	target: SecurityAuditTarget | null,
	timeZone: string,
): Html =>
	detailTitle(h, {
		kind: ["Finding"],
		title: [finding.record.title],
		meta: [
			...headerBadges(h, finding),
			h.div(
				[h.Class("flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground")],
				[
					metaItem(h, "GithubIcon", [target?.repository ?? "Removed target"]),
					h.span(
						[],
						[
							"first seen in ",
							h.a(
								[
									h.Href(runHref(finding.firstSeenRunId)),
									h.Class("font-mono underline underline-offset-2"),
								],
								[`run ${shortId(finding.firstSeenRunId)}`],
							),
						],
					),
					h.span(
						[],
						[
							"last seen ",
							relativeTime(h, {
								value: finding.updatedAt,
								nowMs: model.nowMs,
								timeZone,
								variant: "short",
								tooltip: "title",
							}),
							" ago at ",
							h.span(
								[h.Class("font-mono")],
								[`${target?.branch ?? "branch"} @ ${refLabel(finding.lastSeenRef)}`],
							),
						],
					),
				],
			),
		],
	})

const triagePanel = (h: H, model: Model, finding: SecurityAuditFinding): Html => {
	const picked = pickedTriageOf(model, finding)
	const isChange = picked !== currentTriageOf(finding) || finding.status === "fixed"
	const reasonError = model.isTriageSubmitted ? reasonErrorOf(model.reason.value) : null
	const ids: Field.FieldIds = {
		control: "security-triage-reason",
		label: "security-triage-reason-label",
		error: "security-triage-reason-error",
		description: "security-triage-reason-description",
	}
	const state = Field.stateOf(model.reason, reasonError !== null)
	if (!model.isAdmin)
		return detailRailGroup(h, "Triage", [
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				["Only org admins can change a finding's status."],
			),
		])
	return detailRailGroup(h, "Triage", [
		h.form(
			[h.Class("flex flex-col gap-3"), h.OnSubmit(Message.SubmittedTriage())],
			[
				ToggleGroup.view(h, {
					model: model.triage,
					toParentMessage: (message) => Message.GotTriageMessage({ message }),
					items: TRIAGE_OPTIONS,
					variant: "outline",
					size: "xs",
					className: "w-full",
					itemClassName: "min-w-0 flex-1 px-1",
				}),
				h.p(
					[h.Class("text-xs text-muted-foreground")],
					[
						finding.status === "fixed"
							? "A later run no longer finds this. Reopen it, dismiss it or accept the risk."
							: "Fixed is set by a later run that no longer finds this fingerprint. A fixed finding reopens if it comes back.",
					],
				),
				Field.field(h, { state }, [
					Field.fieldLabel(h, { ids, state }, "Reason"),
					textarea(h, {
						id: ids.control,
						attributes: [
							h.Placeholder(
								picked === "open" && finding.status !== "open"
									? "Why is this being reopened?"
									: "Why is this being dismissed or accepted?",
							),
							h.AriaLabelledBy(ids.label),
							h.AriaDescribedBy(reasonError === null ? (ids.description ?? "") : ids.error),
							h.AriaInvalid(reasonError !== null),
							h.Rows(3),
							h.Value(model.reason.value),
							h.OnInput((value) =>
								Message.GotReasonMessage({ message: Field.Message.ChangedValue({ value }) }),
							),
							h.OnBlur(Message.GotReasonMessage({ message: Field.Message.BlurredControl() })),
						],
					}),
					reasonError === null
						? Field.fieldDescription(
								h,
								{ ids, state },
								"Required. Recorded in the org audit log with your name.",
							)
						: Field.fieldError(h, { ids, state, attributes: [h.Role("alert")] }, reasonError),
				]),
				button(
					h,
					{
						type: "submit",
						variant: "outline",
						isLoading: model.isSaving,
						isDisabled: !isChange || model.isSaving,
						className: "w-full",
					},
					["Update status"],
				),
			],
		),
	])
}

const railValue = (h: H, text: string): Html => h.span([h.Class("truncate text-sm capitalize")], [text])

const detailsPanel = (
	h: H,
	model: Model,
	finding: SecurityAuditFinding,
	target: SecurityAuditTarget | null,
	timeZone: string,
): Html => {
	const { record } = finding
	const rows: ReadonlyArray<Html> = [
		...(finding.overallSeverity === null
			? []
			: [
					detailRailRow(h, { label: "Severity" }, [
						railValue(h, SECURITY_SEVERITY_LABEL[finding.overallSeverity]),
					]),
				]),
		...(record.verdict === "confirmed"
			? [
					detailRailRow(h, { label: "Likelihood" }, [
						railValue(h, record.severity.likelihood.score),
					]),
					detailRailRow(h, { label: "Impact" }, [railValue(h, record.severity.impact.score)]),
					detailRailRow(h, { label: "Confidence" }, [railValue(h, record.confidence.score)]),
				]
			: []),
		detailRailRow(h, { label: "Target" }, [
			h.span(
				[h.Class("truncate"), h.Title(target?.repository ?? "")],
				[target === null ? "Removed target" : `${target.repository} · ${target.branch}`],
			),
		]),
		detailRailRow(h, { label: "First seen" }, [
			h.a(
				[
					h.Href(runHref(finding.firstSeenRunId)),
					h.Class("font-mono text-sm underline-offset-2 hover:underline active:underline"),
				],
				[`run ${shortId(finding.firstSeenRunId)}`],
			),
		]),
		detailRailRow(h, { label: "Last seen" }, [
			h.a(
				[
					h.Href(runHref(finding.lastSeenRunId)),
					h.Class("font-mono text-sm underline-offset-2 hover:underline active:underline"),
				],
				[`run ${shortId(finding.lastSeenRunId)}`],
			),
		]),
		detailRailRow(h, { label: "Fingerprint", title: finding.fingerprint }, [
			h.span([h.Class("truncate font-mono text-xs")], [finding.fingerprint]),
			copyButton(h, {
				label: "fingerprint",
				status: model.copy.status,
				onClick: Message.GotCopyMessage({
					message: CopyButton.Message.ClickedCopy({ text: finding.fingerprint }),
				}),
				className: "ml-1 shrink-0",
			}),
		]),
	]
	return h.div(
		[],
		[detailRailGroup(h, "Details", rows), detailRailGroup(h, "Activity", activity(h, finding, timeZone))],
	)
}

const activityItem = (h: H, text: string, at: number, timeZone: string): Html =>
	h.li(
		[h.Key(`${at}-${text}`), h.Class("flex flex-col gap-0.5 border-l-2 pl-3")],
		[
			h.span([h.Class("text-sm")], [text]),
			h.span([h.Class("text-xs text-muted-foreground")], [formatTimestampInTimezone(at, { timeZone })]),
		],
	)

/** What the record says happened to it, newest first. */
const activity = (h: H, finding: SecurityAuditFinding, timeZone: string): ReadonlyArray<Html> => [
	h.ol(
		[h.Class("flex flex-col gap-3")],
		[
			...(finding.statusChangedAt === null
				? []
				: [
						activityItem(
							h,
							`Marked ${FINDING_STATUS_LABEL[finding.status].toLowerCase()}${finding.statusReason === null ? "" : `: ${finding.statusReason}`}`,
							finding.statusChangedAt,
							timeZone,
						),
					]),
			...(finding.lastSeenRunId === finding.firstSeenRunId
				? []
				: [
						activityItem(
							h,
							`Seen again in run ${shortId(finding.lastSeenRunId)}.`,
							finding.updatedAt,
							timeZone,
						),
					]),
			activityItem(
				h,
				`Reported in run ${shortId(finding.firstSeenRunId)} with the verdict ${VERDICT_LABEL[finding.verdict].toLowerCase()}.`,
				finding.createdAt,
				timeZone,
			),
		],
	),
]

const loaded = (h: H, model: Model, finding: SecurityAuditFinding, timeZone: string): Html => {
	const target = targetOf(model)
	return dashboardPage(
		h,
		{
			titleContent: title(h, model, finding, target, timeZone),
			rightPanel: h.div(
				[h.Class("flex flex-col")],
				[triagePanel(h, model, finding), detailsPanel(h, model, finding, target, timeZone)],
			),
			scrollClassName: "pb-8",
		},
		[stack(h, findingBody(h, finding))],
	)
}

/** The target or the finding does not exist: the same way back either way. */
const NOT_FOUND_CODES: ReadonlySet<string> = new Set([
	"security_audit_finding_not_found",
	"security_audit_target_not_found",
])

const findingNotFound = (h: H): Html =>
	resourceNotFound(h, {
		title: "Finding not found",
		description: "It may belong to another target or organization, or the link is stale.",
		back: { href: hrefOf(AppRoute.SecurityCodeFindings({ search: {} })), label: "Back to findings" },
	})

const failed = (h: H, failure: LoadFailure, title: string): Html => {
	const gate = gateOf(failure)
	return dashboardPage(h, {}, [
		NOT_FOUND_CODES.has(failure.code)
			? findingNotFound(h)
			: gate === null
				? errorState(h, { failure, title, onRetry: Message.ClickedRetry() })
				: stack(h, [gateState(h, gate)]),
	])
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	AsyncData.matchData(model.findings.data, {
		onEmpty: () =>
			dashboardPage(h, { titleContent: detailTitleSkeleton(h) }, [
				placeholder(h, "h-40 w-full"),
				placeholder(h, "h-64 w-full"),
			]),
		onFailure: (failure) => failed(h, failure, "Couldn't load the finding"),
		onData: () => {
			const finding = findingOf(model)
			if (finding === null) return dashboardPage(h, {}, [findingNotFound(h)])
			// A failed targets read is not a removed target: show it, with a retry.
			return AsyncData.isFailure(model.targets.data)
				? failed(h, model.targets.data.error, "Couldn't load the finding's target")
				: loaded(h, model, finding, inputs.context.timeZone)
		},
	}),
)

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	...codeCrumbs({ label: "Findings", href: hrefOf(AppRoute.SecurityCodeFindings({ search: {} })) }),
	{ label: findingOf(model)?.record.title ?? "Finding" },
]
