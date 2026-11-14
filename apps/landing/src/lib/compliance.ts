/**
 * Where Maple stands on compliance. The `.md` twins render this list; `/pricing`
 * and `/eu` say the same in their own layout, so a status change edits both.
 *
 * Only `available` may be shown as held. SOC 2 and ISO 27001 are audits in
 * progress, and no copy may round that up to a certification.
 */
import { Array as Arr } from "effect"
import * as m from "../paraglide/messages.js"
import { PRIVACY_EMAIL } from "./agent-resources"
import { table } from "./page-markdown"

type ComplianceStatus = "available" | "in_progress"

interface ComplianceItem {
	readonly id: "dpa" | "soc2" | "iso27001"
	/** Standard names, the same in every locale. */
	readonly name: string
	readonly status: ComplianceStatus
	/** Where a buyer gets it, for items they can request. */
	readonly href?: string
}

export const DPA_REQUEST_URL = `mailto:${PRIVACY_EMAIL}?subject=DPA%20request`

const complianceItems: ReadonlyArray<ComplianceItem> = [
	{ id: "dpa", name: "DPA", status: "available", href: DPA_REQUEST_URL },
	{ id: "soc2", name: "SOC 2 Type II", status: "in_progress" },
	{ id: "iso27001", name: "ISO 27001", status: "in_progress" },
]

const complianceStatusLabel = (status: ComplianceStatus): string =>
	status === "available" ? m.compliance_available() : m.compliance_in_progress()

/** The `.md` twins' version: a status table and where to request the DPA. */
export const complianceMarkdown = (): string =>
	`${table(
		["", m.compliance_status()],
		Arr.map(complianceItems, (item) => [item.name, complianceStatusLabel(item.status)]),
	)}\n\n${m.compliance_dpa_request({ email: `[${PRIVACY_EMAIL}](mailto:${PRIVACY_EMAIL})` })}`
