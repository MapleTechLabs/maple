import type { AuditDetection } from "@maple/domain/http"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import * as Keyed from "@maple/views/data/keyed"
import { Array as Arr, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import {
	empty,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { item, itemActions, itemContent, itemDescription, itemTitle } from "@maple/views/ui/item"
import { panel } from "@maple/views/ui/panel"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { hstack, vstack } from "@maple/views/ui/stack"
import { switchControl } from "@maple/views/ui/switch"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography, typographyClass } from "@maple/views/ui/typography"
import type { PageViewInputs } from "../../contract"
import { severityBadge } from "../../alerts/shared/badges"
import {
	conditionText,
	detectionFormHref,
	EVERY_EVENT,
	isForbidden,
	matchText,
} from "../kit/detection-format"
import { DETECTION_TEMPLATES, type DetectionTemplate } from "../kit/detection-templates"
import { securityLayout, WIDE_COLUMN } from "../kit/layout"
import { placeholderRows } from "../kit/parts"
import { detectionById, detectionsOf, notifiesText } from "./derive"
import { accessOf, Message, type Model } from "./model"

type H = HtmlBuilder<Message>

// On a phone the name column takes the width the hidden ones leave, and a long name wraps in it.
const NARROW_NAME = "max-w-44 whitespace-normal sm:max-w-72 sm:whitespace-nowrap"

/** What the detection counts: the filters by name, then the exact action as the platform writes it. */
const matchLine = (h: H, detection: AuditDetection): Html => {
	const labels = matchText(detection.filters)
	const { action } = detection.filters
	const small = typographyClass({ size: "xs", tone: "muted" })
	if (labels === "" && action === undefined)
		return typography(h, { size: "xs", tone: "muted", truncate: true }, [EVERY_EVENT])
	// The names stay whole; a long action is what gives way, onto its own line on a phone.
	return hstack(h, { gap: "1.5", align: "center", wrap: true, shrink: true }, [
		...(labels === "" ? [] : [typography(h, { size: "xs", tone: "muted" }, [labels])]),
		...(labels === "" || action === undefined
			? []
			: [
					typography(
						h,
						// A phone wraps the action onto its own line, where a trailing dot would dangle.
						{
							size: "xs",
							tone: "faint",
							className: "hidden sm:inline",
							attributes: [h.AriaHidden(true)],
						},
						["·"],
					),
				]),
		...(action === undefined
			? []
			: [
					truncatedText(h, {
						text: action,
						mono: true,
						tooltip: "overflow",
						className: `max-w-full ${small}`,
					}),
				]),
	])
}

/** Who is told when it fires. Nobody is a state worth seeing: the incident opens and no one hears. */
const notifies = (h: H, detection: AuditDetection): Html => {
	const text = notifiesText(detection)
	return text === null
		? hstack(
				h,
				{ gap: "1.5", align: "center", className: typographyClass({ size: "xs", tone: "warning" }) },
				[icon(h, "BellSlashIcon", { size: 14 }), "Notifies no one"],
			)
		: typography(h, { size: "xs", tone: "muted" }, [text])
}

const detectionRow = (h: H, model: Model, detection: AuditDetection): Html => {
	const condition = conditionText(detection.threshold, detection.windowMinutes)
	const isBusy = Arr.contains(model.togglingIds, detection.id) || model.deletingId === detection.id
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					vstack(h, { gap: "0.5", shrink: true }, [
						textLink(
							h,
							{
								tone: "inherit",
								href: detectionFormHref({ detectionId: detection.id }),
								className: typographyClass({
									size: "sm",
									weight: "medium",
									className: "block break-words sm:truncate",
								}),
							},
							[detection.name],
						),
						matchLine(h, detection),
						// A phone has no Condition, Severity or Notifies column: they ride under the name.
						hstack(h, { gap: "2", align: "center", wrap: true, className: "sm:hidden" }, [
							typography(h, { size: "xs", tone: "muted" }, [condition]),
							severityBadge(h, detection.severity),
							...(detection.destinationIds.length === 0 ? [notifies(h, detection)] : []),
						]),
					]),
				],
				NARROW_NAME,
			),
			tableCell(h, [typography(h, { size: "xs", numeric: true }, [condition])], WIDE_COLUMN),
			tableCell(h, [severityBadge(h, detection.severity)], WIDE_COLUMN),
			tableCell(h, [notifies(h, detection)], WIDE_COLUMN),
			tableCell(h, [
				hstack(h, { gap: "1", align: "center", justify: "end" }, [
					...switchControl(h, {
						id: `detection-switch-${detection.id}`,
						inputId: `detection-switch-input-${detection.id}`,
						isChecked: detection.enabled,
						isDisabled: isBusy,
						ariaLabel: `${detection.enabled ? "Disable" : "Enable"} ${detection.name}`,
						className: "mr-2",
						onToggle: Message.ToggledDetection({ id: detection.id }),
					}),
					iconButton(
						h,
						{
							label: `Edit ${detection.name}`,
							attributes: [h.OnClick(Message.ClickedEdit({ id: detection.id }))],
						},
						[icon(h, "PencilIcon")],
					),
					iconButton(
						h,
						{
							label: `Delete ${detection.name}`,
							isDisabled: isBusy,
							attributes: [h.OnClick(Message.ClickedDelete({ id: detection.id }))],
						},
						[icon(h, "TrashIcon")],
					),
				]),
			]),
		],
		undefined,
		[h.Key(detection.id)],
	)
}

const detectionsTable = (h: H, model: Model, detections: ReadonlyArray<AuditDetection>): Html =>
	table(h, { ariaLabel: "Detections" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Detection"]),
				tableHead(h, ["Fires on"], `w-44 ${WIDE_COLUMN}`),
				tableHead(h, ["Severity"], `w-24 ${WIDE_COLUMN}`),
				tableHead(h, ["Notifies"], `w-36 ${WIDE_COLUMN}`),
				tableHead(h, [typography(h, { className: "sr-only" }, ["Enabled and actions"])], "w-36"),
			]),
		]),
		tableBody(
			h,
			Arr.map(detections, (detection) => detectionRow(h, model, detection)),
		),
	])

/** One ready-made detection: what it is, when it fires, and the editor filled in with it. */
const templateCard = (h: H, template: DetectionTemplate): Html =>
	item(h, { variant: "card", size: "lg", className: "text-left", tag: "li" }, [
		itemContent(h, [itemTitle(h, [template.title]), itemDescription(h, [template.summary])]),
		itemActions(h, [
			linkButton(
				h,
				{
					variant: "outline",
					size: "sm",
					href: detectionFormHref({ template: template.id }),
					attributes: [h.AriaLabel(`Use template: ${template.title}`)],
				},
				["Use template"],
			),
		]),
	])

/** Nothing set up yet: the common detections to start from, so the page is never a blank slate. */
const onRamp = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "RadarIcon")]),
				emptyTitle(h, ["No detections yet"]),
				emptyDescription(h, [
					"Start from a common one. It opens in the editor filled in, and nothing is created until you save.",
				]),
			]),
			vstack(
				h,
				{ as: "ul", gap: "2", className: "w-full max-w-2xl" },
				Arr.map(DETECTION_TEMPLATES, (template) => templateCard(h, template)),
			),
			emptyActions(h, [
				linkButton(h, { variant: "ghost", size: "sm", href: detectionFormHref() }, [
					icon(h, "PlusIcon"),
					"Start from scratch",
				]),
			]),
		],
		"py-12",
	)

/** Not an org admin: the page says who can read it. */
const adminsOnly = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "LockIcon")]),
				emptyTitle(h, ["Only org admins can see and change detections"]),
				emptyDescription(h, [
					"A detection counts audit events, which record who did what. You still see its incidents in Alerts.",
				]),
			]),
		],
		emptyFrameClass("dashed"),
	)

/** What a member sees of a detection, said once: its rule row syncs to every member's browser. */
const footnote = (h: H): Html =>
	typography(h, { size: "xs", tone: "muted", as: "p" }, [
		"Every member of the org can see a detection's name and that it fired. Only org admins see the events it counted.",
	])

const listBody = (h: H, model: Model): ReadonlyArray<Html> =>
	AsyncData.matchData(model.list.data, {
		onEmpty: () => [placeholderRows(h, 4)],
		onFailure: (failure) => [
			errorState(h, {
				failure,
				title: "Couldn't load detections",
				onRetry: Message.ClickedRetry(),
			}),
		],
		onData: () => {
			const detections = detectionsOf(model) ?? []
			if (detections.length === 0) return [onRamp(h), footnote(h)]
			const isRefetching = Keyed.isInFlight(model.list)
			return [
				panel(
					h,
					{
						className: `overflow-hidden ${refreshingClass(isRefetching)}`,
						attributes: [h.AriaBusy(isRefetching)],
					},
					[detectionsTable(h, model, detections)],
				),
				footnote(h),
			]
		},
	})

const deleteDialog = (h: H, model: Model): Html => {
	const name = Option.match(detectionById(model, model.confirmDeleteId), {
		onNone: () => "this detection",
		onSome: (detection) => detection.name,
	})
	return confirmDialog(h, {
		slotId: "security-detection-delete",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: `Delete ${name}?`,
		description:
			"It stops counting audit events, and the incidents it opened are deleted with it. This cannot be undone.",
		confirmLabel: "Delete detection",
		isPending: model.deletingId !== null,
		onConfirm: Message.ClickedConfirmDelete(),
	})
}

/** The session, or the API when the session could not say, refused the viewer. */
const isRefused = (model: Model): boolean =>
	accessOf(model) === "denied" ||
	AsyncData.matchData(model.list.data, {
		onEmpty: () => false,
		onFailure: isForbidden,
		onData: () => false,
	})

const newDetectionButton = (h: H): Html =>
	linkButton(h, { size: "sm", href: detectionFormHref() }, [icon(h, "PlusIcon"), "New detection"])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	if (accessOf(model) === "unknown")
		return securityLayout(h, { source: "detections" }, [placeholderRows(h, 4)])
	if (isRefused(model)) return securityLayout(h, { source: "detections" }, [adminsOnly(h)])
	return securityLayout(
		h,
		{ source: "detections", actions: newDetectionButton(h), overlay: [deleteDialog(h, model)] },
		listBody(h, model),
	)
})
