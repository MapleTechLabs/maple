import type { GcpCostConnector, GcpCostStatus } from "@maple/domain/http"
import { Array as Arr, Option, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Field from "@maple/views/ui/field"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel, input } from "@maple/views/ui/field"
import { icon } from "@maple/views/ui/icon"
import { listRow } from "@maple/views/ui/list-row"
import { vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../route"
import { codeBlock } from "../kit/code-block"
import { connectionStep, type ConnectionStepAction } from "../kit/connection-step"
import { GCP_EXPORT_DOCS_HREF, gcpConnectorOf, gcpGrantCommands } from "./gcp-export"
import { Message } from "./message"
import type { Model } from "./model"
import { COST_PROVIDERS } from "./providers"
import { addTrail } from "./view-add-trail"
import { providerMark } from "./view-add-vercel"

type H = HtmlBuilder<Message>

/** Where Google Cloud is connected to Maple. */
const CONNECT_GCP_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "gcp" } }))

/** Where a GCP connection's Metrics and resources switch is turned on. */
export const GCP_INTEGRATION_HREF = hrefOf(AppRoute.Integrations({ search: { integration: "gcp" } }))

const TABLE_IDS: FieldIds = {
	control: "cost-gcp-table",
	label: "cost-gcp-table-label",
	error: "cost-gcp-table-error",
	description: "cost-gcp-table-description",
}

/** A connection as the step lists it: the scope it reads, and whether its reader can be used. */
const connectorRow = (h: H, connector: GcpCostConnector, isSelected: boolean, isOnly: boolean): Html => {
	const row = {
		leading: providerMark(h, COST_PROVIDERS.gcp),
		title: connector.scopeId,
		meta: connector.metricsEnabled
			? `${Str.capitalize(connector.scopeType)} · queries run in ${connector.projectId}`
			: "Turn on Metrics and resources for this connection first",
		wrapMeta: true,
		selected: isSelected,
	}
	// One connection is the choice already; one without a reader cannot be picked.
	return isOnly || !connector.metricsEnabled
		? listRow(h, row)
		: listRow(h, {
				...row,
				onClick: Message.PickedGcpConnector({ connectorId: connector.id }),
				trailing: isSelected ? icon(h, "CheckIcon", { size: 14 }) : undefined,
			})
}

const tableField = (h: H, model: Model): Html => {
	const state = Field.stateOf(model.gcpTableDraft, model.gcpError !== null)
	return field(h, { state }, [
		fieldLabel(h, { ids: TABLE_IDS, state }, "Billing export table"),
		input(h, {
			ids: TABLE_IDS,
			state,
			attributes: [
				h.Attribute("autocomplete", "off"),
				h.Attribute("spellcheck", "false"),
				h.Placeholder("billing-project.billing_export.gcp_billing_export_resource_v1_…"),
				...(model.sourceWrite === "Saving" ? [h.Disabled(true)] : []),
				...Field.controlAttributes(h, model.gcpTableDraft, (message) =>
					Message.GotGcpTableDraftMessage({ message }),
				),
			],
		}),
		...(model.gcpError === null
			? []
			: [fieldError(h, { ids: TABLE_IDS, state, attributes: [h.Role("alert")] }, [model.gcpError])]),
		fieldDescription(h, { ids: TABLE_IDS, state }, [
			"The table's ID from BigQuery. The detailed export names each resource; the standard one works too. ",
			textLink(
				h,
				{
					href: GCP_EXPORT_DOCS_HREF,
					tone: "inherit",
					className: "underline",
					attributes: [h.Target("_blank"), h.Rel("noreferrer")],
				},
				["Set up the export"],
			),
		]),
	])
}

/** The step's body: the connection to read through, the table, and the grants to run once. */
const content = (h: H, model: Model, status: GcpCostStatus): ReadonlyArray<Html> => {
	if (!Arr.isReadonlyArrayNonEmpty(status.connectors)) {
		return [
			typography(h, { size: "sm", tone: "muted", as: "p", className: "font-prose" }, [
				"No Google Cloud project is connected yet. Connect one with Metrics and resources on, then add its billing export here.",
			]),
		]
	}
	const chosen = gcpConnectorOf(status, model.gcpConnectorId)
	const isOnly = status.connectors.length === 1
	return [
		vstack(
			h,
			{ gap: "0" },
			Arr.map(status.connectors, (connector) =>
				connectorRow(
					h,
					connector,
					Option.exists(chosen, (picked) => picked.id === connector.id),
					isOnly,
				),
			),
		),
		...Option.match(chosen, {
			onNone: () => [
				typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
					"Maple reads the export as the connection's read-only service account, which exists while Metrics and resources is on. ",
					textLink(h, { href: GCP_INTEGRATION_HREF, tone: "inherit", className: "underline" }, [
						"Open the Google Cloud connection",
					]),
				]),
			],
			onSome: (connector) => [
				tableField(h, model),
				vstack(h, { gap: "2" }, [
					typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
						"Run once in Cloud Shell: the connection's read-only account may then query the export table, and nothing else in its dataset. Each sync's query is billed to ",
						connector.projectId,
						".",
					]),
					codeBlock(h, {
						code: gcpGrantCommands(connector, model.gcpTableDraft.value),
						language: "Cloud Shell",
						lang: "bash",
						copy: model.gcpCommandCopy,
						toCopyMessage: (message) => Message.GotGcpCommandCopyMessage({ message }),
					}),
				]),
				...(Arr.isReadonlyArrayNonEmpty(status.exports)
					? [
							typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
								`Billing accounts already added: ${Arr.join(
									Arr.map(status.exports, (exp) => exp.billingAccountId),
									", ",
								)}.`,
							]),
						]
					: []),
			],
		}),
	]
}

const primary = (model: Model, status: GcpCostStatus): ConnectionStepAction<Message> | null => {
	if (!Arr.isReadonlyArrayNonEmpty(status.connectors)) {
		return { label: "Connect Google Cloud", href: CONNECT_GCP_HREF }
	}
	if (Option.isNone(gcpConnectorOf(status, model.gcpConnectorId))) {
		return { label: "Open the Google Cloud connection", href: GCP_INTEGRATION_HREF }
	}
	return {
		label: "Add source",
		onClick: Message.SubmittedGcpExport(),
		isLoading: model.sourceWrite === "Saving",
		isDisabled: Str.trim(model.gcpTableDraft.value) === "",
	}
}

/**
 * The dialog's Google Cloud step: a connection whose read-only account queries the org's Cloud
 * Billing export to BigQuery, the export table's id, and the grants that let it.
 */
export const gcpStep = (h: H, model: Model, id: string): ReadonlyArray<Html> =>
	connectionStep(h, {
		dialogId: id,
		title: "Add Google Cloud",
		trail: addTrail(h, "Google Cloud"),
		description:
			"Google has no API for cost: Maple reads your Cloud Billing export to BigQuery each day, by project, service, SKU, region and resource, credits apart.",
		read: model.gcp.data,
		readingLabel: "Reading your Google Cloud connections",
		onRetry: Message.ClickedAddGcp(),
		content: (status) => content(h, model, status),
		primary: (status) => primary(model, status),
		onBack: Message.ClickedBackToProviders(),
		isBusy: model.sourceWrite === "Saving",
	})

/** What removing a Google Cloud source says. */
export const GCP_REMOVE = {
	title: "Remove the Google Cloud source?",
	description:
		"Maple stops reading this billing export, and its cost leaves this page. The export, its BigQuery grants and the Google Cloud connection stay as they are. Adding it again reads the last thirteen months the export holds.",
} as const
