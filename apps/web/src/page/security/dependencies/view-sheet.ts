import type { DependencyFindingView } from "@maple/domain/http"
import { displayAdvisoryId } from "@maple/domain/package-advisories"
import { formatRate } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { detailRailGroup, detailRailRow } from "@maple/views/ui/detail-rail"
import { badge } from "@maple/views/ui/display"
import * as DialogView from "@maple/views/ui/dialog-view"
import * as Field from "@maple/views/ui/field"
import { textarea } from "@maple/views/ui/textarea"
import { relativeTime } from "../../kit/relative-time"
import { sheetDetailHeader } from "../../kit/sheet-detail-header"
import { RELATION_LABEL, reasonErrorOf, selectedFindingOf, shortSha, STATUS_FILTER_LABEL } from "./derive"
import { canManage, Message, type Model } from "./model"
import { advisorySeverityBadge } from "../kit/parts"
import { advisoryLink } from "./view-findings"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"

// The finding's sheet: what the advisory says, where the package is locked, and its triage.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const value = (h: H, text: string, mono = false): Html =>
	h.span(
		[
			h.Class(
				mono
					? typographyClass({ size: "xs", mono: true, truncate: true })
					: typographyClass({ size: "sm", truncate: true }),
			),
			h.Title(text),
		],
		[text],
	)

const at = (h: H, sha: string, epochMs: number, clock: Clock): Html =>
	h.span(
		[h.Class("flex min-w-0 items-center gap-1.5 text-sm")],
		[
			typography(h, { size: "xs", mono: true, attributes: [h.Title(sha)] }, [shortSha(sha)]),
			relativeTime(h, {
				value: epochMs,
				nowMs: clock.nowMs,
				timeZone: clock.timeZone,
				variant: "orDate",
				tooltip: "title",
				className: typographyClass({ size: "xs", tone: "muted" }),
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
					Arr.map(finding.production, (service) =>
						detailRailRow(h, { label: service.environment }, [
							h.span(
								[h.Class("flex min-w-0 items-center justify-end gap-1.5 text-xs")],
								[
									typography(
										h,
										{
											size: "sm",
											truncate: true,
											attributes: [h.Title(service.serviceName)],
										},
										[service.serviceName],
									),
									h.span(
										[
											h.Class("shrink-0 font-mono text-muted-foreground"),
											h.Title(service.commitSha),
										],
										[shortSha(service.commitSha)],
									),
									typography(h, { tone: "muted", numeric: true, className: "shrink-0" }, [
										`${formatRate(service.spanCount)} spans/day`,
									]),
								],
							),
						]),
					),
				),
			]

/** The ids besides the one the advisory link already shows. */
const aliasesBesides = (finding: DependencyFindingView): ReadonlyArray<string> => {
	const shown = displayAdvisoryId({ id: finding.advisoryId, aliases: finding.aliases })
	return Arr.filter([finding.advisoryId, ...finding.aliases], (name) => name !== shown)
}

const details = (h: H, finding: DependencyFindingView, clock: Clock): Html =>
	detailRailGroup(h, "Details", [
		detailRailRow(h, { label: "Advisory" }, [advisoryLink(h, finding)]),
		...(aliasesBesides(finding).length === 0
			? []
			: [
					detailRailRow(h, { label: "Aliases" }, [
						value(h, Arr.join(aliasesBesides(finding), ", "), true),
					]),
				]),
		detailRailRow(h, { label: "Versions" }, [value(h, Arr.join(finding.versions, ", "), true)]),
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
	typography(h, { size: "xs", mono: true, attributes: [h.Title(sha)] }, [shortSha(sha)])

const REASON_IDS: Field.FieldIds = {
	control: "dependency-triage-reason",
	label: "dependency-triage-reason-label",
	error: "dependency-triage-reason-error",
	description: "dependency-triage-reason-description",
}

const reasonField = (h: H, model: Model): Html => {
	// Trimmed as triage sends it, so the field never errors on a reason that was written.
	const error = model.isReasonSubmitted ? reasonErrorOf(Str.trim(model.reason.value)) : null
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

const note = (h: H, text: string): Html => typography(h, { size: "xs", tone: "muted", as: "p" }, [text])

const triage = (h: H, model: Model, finding: DependencyFindingView, clock: Clock): Html => {
	if (!canManage(model))
		return detailRailGroup(h, "Triage", [
			note(h, "Only org admins and engineers can change a finding's status."),
		])
	if (finding.status === "fixed")
		return detailRailGroup(h, "Triage", [
			note(h, "A later scan no longer finds this package version. It reopens if it comes back."),
		])
	if (finding.status !== "open")
		return detailRailGroup(h, "Triage", [
			vstack(h, { gap: "3" }, [
				h.p(
					[h.Class("text-sm")],
					[
						STATUS_FILTER_LABEL[finding.status],
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
							typography(h, { size: "sm", tone: "muted", as: "p", className: "font-prose" }, [
								finding.statusReason,
							]),
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
			]),
		])
	return detailRailGroup(h, "Triage", [
		vstack(h, { gap: "3" }, [
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
		]),
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
		vstackClass({ gap: "6" }),
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
