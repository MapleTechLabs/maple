import type { V2StatusPage, V2StatusPageCustomDomain } from "@maple/domain/http/v2"
import {
	isCustomDomainChallengeRecord,
	type StatusPageCustomDomainRecordPurpose,
} from "@maple/domain/status-page"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import * as CopyButton from "@maple/views/ui/copy-button"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { hstack, vstack } from "@maple/views/ui/stack"
import {
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
	wrappingTableCell,
} from "@maple/views/ui/table"
import { typography } from "@maple/views/ui/typography"
import { failureMessage } from "@maple/views/data/load-failure"
import { settingsSection } from "../../kit/settings-section"
import { textField } from "../shared/fields"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { gatedControl } from "../../kit/session-grants"
import { customDomainDraftIssue, customDomainInput, customDomainOf } from "./update-domain"

// The Settings tab's Custom domain section: the hostname, where it stands, the DNS records to add.

type H = HtmlBuilder<Message>
type DomainStatus = NonNullable<V2StatusPageCustomDomain["status"]>

const STATUS_BADGE = {
	pending_dns: { label: "Waiting for DNS", variant: "warn" },
	pending_ssl: { label: "Issuing certificate", variant: "info" },
	active: { label: "Active", variant: "ok" },
	failed: { label: "Needs attention", variant: "crit" },
} as const satisfies Record<DomainStatus, { label: string; variant: "warn" | "info" | "ok" | "crit" }>

const STATUS_NOTE = {
	pending_dns:
		"Add the records below at your DNS provider. Maple checks every minute for the first hour, then every ten minutes.",
	pending_ssl: "DNS is in place. Cloudflare is issuing the certificate, usually within a few minutes.",
	active: "The page is live on this domain, and its feeds link here.",
	failed: "The domain stopped. Fix what is described below, then check again.",
} as const satisfies Record<DomainStatus, string>

/** While the ownership record is still to be found: both records are needed, and for how long. */
const OWNERSHIP_NOTE =
	"Add both records below at your DNS provider: the CNAME points the domain at Maple and the TXT record proves you own it. You can remove the TXT record once the domain is active. Maple checks every minute for the first hour, then every ten minutes."

const statusNote = (domain: V2StatusPageCustomDomain, status: DomainStatus): string =>
	status === "pending_dns" && Arr.some(domain.dns_records, isCustomDomainChallengeRecord)
		? OWNERSHIP_NOTE
		: STATUS_NOTE[status]

const PURPOSE_LABEL = {
	routing: "Points the domain at Maple",
	ownership: "Proves you own it (optional with the CNAME in place)",
	certificate: "Lets the certificate be issued",
} as const satisfies Record<StatusPageCustomDomainRecordPurpose, string>

const purposeLabel = (record: V2StatusPageCustomDomain["dns_records"][number]): string =>
	isCustomDomainChallengeRecord(record)
		? "Proves you own the domain (needed until it is active)"
		: PURPOSE_LABEL[record.purpose]

const copyCell = (h: H, model: Model, key: string, value: string, label: string): Html =>
	hstack(h, { gap: "1", align: "center" }, [
		typography(h, { size: "xs", mono: true, className: "break-all" }, [value]),
		CopyButton.view(h, {
			model: model.dnsCopyKey === key ? model.dnsCopy : CopyButton.init(),
			toParentMessage: (message) => Message.GotDnsCopyMessage({ key, message }),
			value,
			label,
			size: "icon-xs",
			variant: "ghost",
		}),
	])

const recordsTable = (h: H, model: Model, domain: V2StatusPageCustomDomain): Html =>
	table(h, { variant: "card", size: "sm", ariaLabel: "DNS records to add" }, [
		tableHeader(h, [
			tableRow(h, [tableHead(h, ["Type"]), tableHead(h, ["Name"]), tableHead(h, ["Value"])]),
		]),
		tableBody(
			h,
			Arr.map(domain.dns_records, (record, index) =>
				tableRow(h, [
					tableCell(h, [
						vstack(h, { gap: "1" }, [
							typography(h, { size: "xs", mono: true, weight: "medium" }, [record.type]),
							typography(h, { size: "xs", tone: "muted" }, [purposeLabel(record)]),
						]),
					]),
					// An ownership record's name and value are long: wrapped, their copy buttons stay in view.
					wrappingTableCell(h, [
						copyCell(
							h,
							model,
							`name-${index}`,
							record.name,
							`${record.purpose} ${record.type} name`,
						),
					]),
					wrappingTableCell(h, [
						copyCell(
							h,
							model,
							`value-${index}`,
							record.value,
							`${record.purpose} ${record.type} value`,
						),
					]),
				]),
			),
		),
	])

const domainState = (h: H, model: Model, domain: V2StatusPageCustomDomain): ReadonlyArray<Html> => {
	const status = domain.status
	if (domain.hostname === null || status === null) return []
	const look = STATUS_BADGE[status]
	return [
		vstack(h, { gap: "3" }, [
			hstack(h, { gap: "3", justify: "between", wrap: true }, [
				hstack(h, { gap: "2", align: "center", wrap: true }, [
					inlineCode(h, {}, [domain.hostname]),
					badge(h, { variant: look.variant }, [look.label]),
				]),
				hstack(h, { gap: "2" }, [
					gatedControl(h, model, "status_pages:edit", (isLocked) =>
						button(
							h,
							{
								size: "sm",
								variant: "destructive-outline",
								isDisabled: isLocked || model.customDomainAction !== null,
								attributes: [h.OnClick(Message.ClickedRemoveCustomDomain())],
							},
							["Remove"],
						),
					),
					gatedControl(h, model, "status_pages:edit", (isLocked) =>
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isLoading: model.customDomainAction === "check",
								isDisabled: isLocked || model.customDomainAction !== null,
								attributes: [h.OnClick(Message.ClickedCheckCustomDomain())],
							},
							[icon(h, "ArrowRotateClockwiseIcon"), "Check now"],
						),
					),
				]),
			]),
			typography(h, { size: "sm", tone: "muted", as: "p" }, [statusNote(domain, status)]),
			...(domain.last_error === null || status === "active"
				? []
				: [
						alert(h, { variant: status === "failed" ? "crit" : "warn", size: "sm" }, [
							icon(h, status === "failed" ? "CircleXmarkIcon" : "CircleInfoIcon"),
							alertTitle(h, [status === "failed" ? "What went wrong" : "Last check"]),
							alertDescription(h, [domain.last_error]),
						]),
					]),
			...(domain.dns_records.length === 0 ? [] : [recordsTable(h, model, domain)]),
		]),
	]
}

/** An internal page answers nowhere public, so it takes no custom domain. */
const INTERNAL_NOTE = "An internal page has no public address. Make it public or password-protected first."

const hostnameForm = (h: H, model: Model, page: V2StatusPage, domain: V2StatusPageCustomDomain): Html => {
	const issue = customDomainDraftIssue(model)
	const isUnchanged = model.customDomainDraft === null || customDomainInput(model) === domain.hostname
	const isInternal = page.visibility === "internal"
	return h.form(
		[h.AriaLabel("Custom domain"), h.OnSubmit(Message.SubmittedCustomDomain())],
		[
			textField(h, {
				id: "status-page-custom-domain",
				label: "Hostname",
				value: customDomainInput(model),
				placeholder: "status.acme.com",
				isMono: true,
				isDisabled: !canManage(model) || isInternal,
				error:
					issue ??
					(model.customDomainFailure === null ? null : failureMessage(model.customDomainFailure)),
				hint: isInternal
					? INTERNAL_NOTE
					: domain.cname_target === null
						? undefined
						: `A subdomain you control, CNAMEd to ${domain.cname_target}.`,
				onInput: (value) => Message.ChangedCustomDomain({ value }),
				trailing: gatedControl(h, model, "status_pages:edit", (isLocked) =>
					button(
						h,
						{
							size: "default",
							type: "submit",
							isLoading: model.customDomainAction === "set",
							isDisabled:
								isLocked ||
								isInternal ||
								isUnchanged ||
								issue !== null ||
								model.customDomainAction !== null,
						},
						[domain.hostname === null ? "Add domain" : "Change domain"],
					),
				),
			}),
		],
	)
}

export const customDomainSection = (h: H, model: Model, page: V2StatusPage): Html =>
	settingsSection(
		h,
		{
			id: "status-page-settings-custom-domain",
			framed: false,
			anchorId: "custom-domain",
			title: "Custom domain",
			description: [
				"Serve the page on your own domain, like status.acme.com, with a certificate Maple manages.",
			],
		},
		[
			Option.match(customDomainOf(model), {
				onSome: (domain) =>
					domain.available
						? vstack(h, { gap: "5" }, [
								hostnameForm(h, model, page, domain),
								...domainState(h, model, domain),
							])
						: typography(h, { size: "sm", tone: "muted", as: "p" }, [
								"Custom domains are unavailable on this Maple deployment.",
							]),
				onNone: () =>
					Option.match(AsyncData.getError(model.customDomain.data), {
						onNone: () => typography(h, { size: "sm", tone: "muted", as: "p" }, ["Loading…"]),
						onSome: (failure) =>
							alert(h, { variant: "crit", size: "sm" }, [
								icon(h, "CircleXmarkIcon"),
								alertTitle(h, ["Couldn't load the custom domain"]),
								alertDescription(h, [failureMessage(failure)]),
								alertAction(h, [
									button(
										h,
										{
											size: "sm",
											variant: "outline",
											isLoading: model.customDomain.retrying === true,
											attributes: [h.OnClick(Message.ClickedRetryCustomDomain())],
										},
										["Try again"],
									),
								]),
							]),
					}),
			}),
		],
	)

export const removeCustomDomainDialog = (h: H, model: Model): Html => {
	const hostname = Option.match(customDomainOf(model), {
		onNone: () => null,
		onSome: (domain) => domain.hostname,
	})
	return confirmDialog(h, {
		slotId: "status-page-remove-custom-domain",
		model: model.removeCustomDomainDialog,
		toParentMessage: (message) => Message.GotRemoveCustomDomainDialogMessage({ message }),
		title: `Remove ${hostname ?? "the custom domain"}?`,
		description:
			"The page stops answering on it within a minute and stays up at its Maple address. You can add it back later.",
		confirmLabel: "Remove domain",
		isPending: model.customDomainAction === "remove",
		onConfirm: Message.ClickedConfirmRemoveCustomDomain(),
	})
}
