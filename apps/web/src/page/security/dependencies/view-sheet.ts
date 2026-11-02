import type { DependencyFindingView } from "@maple/domain/http"
import { displayAdvisoryId } from "@maple/domain/package-advisories"
import { formatRate } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { detailRailGroup, detailRailRow } from "../../../ui/detail-rail"
import { badge } from "../../../ui/display"
import * as DialogView from "../../../ui/dialog-view"
import * as Field from "../../../ui/field"
import { textarea } from "../../../ui/textarea"
import { relativeTime } from "../../kit/relative-time"
import { sheetDetailHeader } from "../../kit/sheet-detail-header"
import { RELATION_LABEL, reasonErrorOf, selectedFindingOf, shortSha, STATUS_FILTER_LABEL } from "./derive"
import { Message, type Model } from "./model"
import { advisorySeverityBadge } from "../kit/parts"
import { advisoryLink } from "./view-findings"

// The finding's sheet: what the advisory says, where the package is locked, and its triage.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const value = (h: H, text: string, mono = false): Html =>
	h.span([h.Class(mono ? "truncate font-mono text-xs" : "truncate text-sm"), h.Title(text)], [text])

const at = (h: H, sha: string, epochMs: number, clock: Clock): Html =>
	h.span(
		[h.Class("flex min-w-0 items-center gap-1.5 text-sm")],
		[
			h.span([h.Class("font-mono text-xs"), h.Title(sha)], [shortSha(sha)]),
			relativeTime(h, {
				value: epochMs,
				nowMs: clock.nowMs,
				timeZone: clock.timeZone,
				variant: "orDate",
				tooltip: "title",
				className: "text-xs text-muted-foreground",
			}),
		],
	)

/** The services running a commit that carries the finding, busiest first. */
const production = (h: H, finding: DependencyFindingView): ReadonlyArray<Html> =>
	finding.production.length === 0
		? []
		: [
				detailRailGroup(
					h,
					"Running in production",
					// The environment labels the row, so a long service name keeps the value's width.
					finding.production.map((service) =>
						detailRailRow(h, { label: service.environment }, [
							h.span(
								[h.Class("flex min-w-0 items-center justify-end gap-1.5 text-xs")],
								[
									h.span(
										[h.Class("truncate text-sm"), h.Title(service.serviceName)],
										[service.serviceName],
									),
									h.span(
										[
											h.Class("shrink-0 font-mono text-muted-foreground"),
											h.Title(service.commitSha),
										],
										[shortSha(service.commitSha)],
									),
									h.span(
										[h.Class("shrink-0 tabular-nums text-muted-foreground")],
										[`${formatRate(service.spanCount)} spans/day`],
									),
								],
							),
						]),
					),
				),
			]

/** The ids besides the one the advisory link already shows. */
const aliasesBesides = (finding: DependencyFindingView): ReadonlyArray<string> => {
	const shown = displayAdvisoryId({ id: finding.advisoryId, aliases: finding.aliases })
	return [finding.advisoryId, ...finding.aliases].filter((name) => name !== shown)
}

const details = (h: H, finding: DependencyFindingView, clock: Clock): Html =>
	detailRailGroup(h, "Details", [
		detailRailRow(h, { label: "Advisory" }, [advisoryLink(h, finding)]),
		...(aliasesBesides(finding).length === 0
			? []
			: [detailRailRow(h, { label: "Aliases" }, [value(h, aliasesBesides(finding).join(", "), true)])]),
		detailRailRow(h, { label: "Versions" }, [value(h, finding.versions.join(", "), true)]),
		detailRailRow(h, { label: "Fixed in" }, [
			finding.fixedIn === null ? value(h, "No fix yet") : value(h, finding.fixedIn, true),
		]),
		detailRailRow(h, { label: "Relation" }, [value(h, RELATION_LABEL[finding.relation])]),
		detailRailRow(h, { label: "Repository" }, [value(h, finding.repositoryFullName)]),
		detailRailRow(h, { label: "Lockfile" }, [value(h, finding.lockfilePath, true)]),
		detailRailRow(h, { label: "First seen" }, [at(h, finding.firstSeenSha, finding.createdAt, clock)]),
		// Commit only: triage rewrites updatedAt, so no stored time says when a scan last matched.
		detailRailRow(h, { label: "Last seen" }, [commit(h, finding.lastSeenSha)]),
		...(finding.fixedSha === null
			? []
			: [detailRailRow(h, { label: "Fixed at" }, [commit(h, finding.fixedSha)])]),
	])

const commit = (h: H, sha: string): Html =>
	h.span([h.Class("font-mono text-xs"), h.Title(sha)], [shortSha(sha)])

const REASON_IDS: Field.FieldIds = {
	control: "dependency-triage-reason",
	label: "dependency-triage-reason-label",
	error: "dependency-triage-reason-error",
	description: "dependency-triage-reason-description",
}

const reasonField = (h: H, model: Model): Html => {
	// Trimmed as triage sends it, so the field never errors on a reason that was written.
	const error = model.isReasonSubmitted ? reasonErrorOf(model.reason.value.trim()) : null
	const state = Field.stateOf(model.reason, error !== null)
	return Field.field(h, { state }, [
		Field.fieldLabel(h, { ids: REASON_IDS, state }, "Reason"),
		textarea(h, {
			id: REASON_IDS.control,
			attributes: [
				h.Placeholder("Why is this not a risk here?"),
				h.AriaLabelledBy(REASON_IDS.label),
				h.AriaDescribedBy(error === null ? (REASON_IDS.description ?? "") : REASON_IDS.error),
				h.AriaInvalid(error !== null),
				h.Rows(3),
				h.Value(model.reason.value),
				h.OnInput((next) =>
					Message.GotReasonMessage({ message: Field.Message.ChangedValue({ value: next }) }),
				),
				h.OnBlur(Message.GotReasonMessage({ message: Field.Message.BlurredControl() })),
			],
		}),
		error === null
			? Field.fieldDescription(h, { ids: REASON_IDS, state }, "Required to dismiss or accept the risk.")
			: Field.fieldError(h, { ids: REASON_IDS, state, attributes: [h.Role("alert")] }, error),
	])
}

const note = (h: H, text: string): Html => h.p([h.Class("text-xs text-muted-foreground")], [text])

const triage = (h: H, model: Model, finding: DependencyFindingView, clock: Clock): Html => {
	if (!model.isAdmin)
		return detailRailGroup(h, "Triage", [note(h, "Only org admins can change a finding's status.")])
	if (finding.status === "fixed")
		return detailRailGroup(h, "Triage", [
			note(h, "A later scan no longer finds this package version. It reopens if it comes back."),
		])
	if (finding.status !== "open")
		return detailRailGroup(h, "Triage", [
			h.div(
				[h.Class("flex flex-col gap-3")],
				[
					h.p(
						[h.Class("text-sm")],
						[
							`${STATUS_FILTER_LABEL[finding.status]}`,
							...(finding.statusChangedAt === null
								? []
								: [
										" ",
										relativeTime(h, {
											value: finding.statusChangedAt,
											nowMs: clock.nowMs,
											timeZone: clock.timeZone,
											variant: "orDate",
											tooltip: "title",
											className: "text-muted-foreground",
										}),
									]),
						],
					),
					...(finding.statusReason === null
						? []
						: [
								h.p(
									[h.Class("font-prose text-sm text-muted-foreground")],
									[finding.statusReason],
								),
							]),
					button(
						h,
						{
							variant: "outline",
							isLoading: model.savingStatus === "open",
							className: "self-start",
							attributes: [h.OnClick(Message.ClickedTriage({ status: "open" }))],
						},
						["Reopen"],
					),
				],
			),
		])
	return detailRailGroup(h, "Triage", [
		h.div(
			[h.Class("flex flex-col gap-3")],
			[
				reasonField(h, model),
				h.div(
					[h.Class("flex gap-2")],
					[
						button(
							h,
							{
								variant: "outline",
								isLoading: model.savingStatus === "dismissed",
								isDisabled: model.savingStatus !== null,
								attributes: [h.OnClick(Message.ClickedTriage({ status: "dismissed" }))],
							},
							["Dismiss"],
						),
						button(
							h,
							{
								variant: "outline",
								isLoading: model.savingStatus === "accepted_risk",
								isDisabled: model.savingStatus !== null,
								attributes: [h.OnClick(Message.ClickedTriage({ status: "accepted_risk" }))],
							},
							["Accept risk"],
						),
					],
				),
			],
		),
	])
}

const content = (h: H, model: Model, finding: DependencyFindingView, clock: Clock): ReadonlyArray<Html> => [
	sheetDetailHeader(h, {
		dialogId: model.sheet.id,
		kind: [finding.ecosystem, finding.repositoryFullName],
		title: [finding.packageName],
		adornment:
			finding.status === "open"
				? null
				: badge(h, { variant: "meta" }, [STATUS_FILTER_LABEL[finding.status]]),
		description: finding.summary ?? `A known vulnerability in ${finding.packageName}`,
		meta: [advisorySeverityBadge(h, finding.severity), advisoryLink(h, finding)],
	}),
	DialogView.dialogPanel(
		h,
		"sheet",
		model.sheet.id,
		[
			h.p(
				[h.Class("font-prose text-sm text-pretty")],
				[finding.summary ?? "The advisory publishes no summary. Read it on OSV.dev."],
			),
			...production(h, finding),
			details(h, finding, clock),
			triage(h, model, finding, clock),
		],
		"flex flex-col gap-6",
	),
]

/** The sheet; its content renders only while a finding is picked and still in the list. */
export const findingSheet = (h: H, model: Model, clock: Clock): Html =>
	h.submodel({
		slotId: `${model.sheet.id}-sheet`,
		model: model.sheet,
		view: DialogView.view,
		viewInputs: {
			className: "p-0 sm:max-w-[480px]",
			side: "right",
			hasTrigger: false,
			isPopupFocused: true,
			toView: ({ portal }) => portal,
			toContent: () => {
				const finding = selectedFindingOf(model)
				return finding === null ? [] : content(h, model, finding, clock)
			},
		},
		toParentMessage: (message) => Message.GotSheetMessage({ message }),
	})
