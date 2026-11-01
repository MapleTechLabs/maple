import type { SecurityAuditRunStatus, SecurityAuditSeverity } from "@maple/domain/security-audit"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon, type IconName } from "../../../ui/icon"
import { severityBadge, severityIcon } from "../../errors/kit/severity"
import { type Gate, issueSeverityOf, runLabelOf, runToneOf, SECURITY_SEVERITY_LABEL } from "./format"

// Marks and states the Security Center's pages share.

type RunState = Readonly<{ status: SecurityAuditRunStatus; incompleteReason: string | null }>

export const runStatusBadge = <M>(h: HtmlBuilder<M>, run: RunState, detail?: string): Html => {
	const tone = runToneOf(run)
	return badge(h, { variant: tone === "neutral" ? "muted" : tone }, [
		detail === undefined ? runLabelOf(run) : `${runLabelOf(run)} · ${detail}`,
	])
}

/** The errors hub's severity glyph; informational and "no severity" draw the unset blocks. */
export const severityMark = <M>(
	h: HtmlBuilder<M>,
	severity: SecurityAuditSeverity | null,
	size = 16,
): Html =>
	severity === "informational"
		? // The unset glyph, named for what it is: role="img" makes the inner svg presentational.
			h.span(
				[h.Role("img"), h.AriaLabel("Informational"), h.Class("inline-flex")],
				[severityIcon(h, null, size)],
			)
		: severityIcon(h, issueSeverityOf(severity), size)

/** The errors kit's severity badge, so "High" is one colour everywhere; informational stays a quiet
 * "Info" chip (the shared badge draws nothing for an unset severity). */
export const securitySeverityBadge = <M>(
	h: HtmlBuilder<M>,
	severity: SecurityAuditSeverity,
	className?: string,
): Html => {
	const level = issueSeverityOf(severity)
	return level === null
		? badge(h, { variant: "muted", className: cn("text-muted-foreground", className) }, [
				SECURITY_SEVERITY_LABEL[severity],
			])
		: severityBadge(h, level, className)
}

/** A still loading block: the skeleton's surface without its sweep. */
export const placeholder = <M>(h: HtmlBuilder<M>, className: string): Html =>
	h.div([h.AriaHidden(true), h.Class(cn("rounded-sm bg-muted", className))])

export const placeholderRows = <M>(h: HtmlBuilder<M>, rows: number, className = "h-10"): Html =>
	h.div(
		[h.AriaBusy(true), h.AriaLabel("Loading"), h.Class("flex flex-col gap-2 p-4")],
		Array.from({ length: rows }, () => placeholder(h, cn("w-full", className))),
	)

/** The page's icon tile, as the empty state draws one. */
export const iconTile = <M>(h: HtmlBuilder<M>, name: IconName): Html =>
	h.span(
		[
			h.AriaHidden(true),
			h.Class(
				"flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-foreground",
			),
		],
		[icon(h, name, { size: 16 })],
	)

const GATE_COPY = {
	disabled: {
		icon: "ShieldIcon",
		title: "Security audits are not enabled for this organization",
		description:
			"Security Center is in beta and rolling out by organization. Nothing is audited until it is enabled here.",
	},
	forbidden: {
		icon: "LockIcon",
		title: "Findings and reports are visible to org admins only",
		description:
			"They can describe how to exploit your code, so only admins can read them. Ask an admin of this organization for access.",
	},
} satisfies Record<Gate, { icon: IconName; title: string; description: string }>

/** A 403 as a quiet state: the org is not in the rollout, or the reader is not an admin. */
export const gateState = <M>(h: HtmlBuilder<M>, gate: Gate, className?: string): Html => {
	const copy = GATE_COPY[gate]
	return empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, copy.icon)]),
				emptyTitle(h, [copy.title]),
				emptyDescription(h, [copy.description]),
			]),
		],
		cn("rounded-md border border-dashed md:py-14", className),
	)
}

/** `owner/` recedes so the repository name carries the row. */
export const repositoryName = <M>(h: HtmlBuilder<M>, fullName: string, className?: string): Html => {
	const slash = fullName.indexOf("/")
	return h.span(
		[h.Class(cn("truncate", className)), h.Title(fullName)],
		[
			h.span([h.Class("text-muted-foreground")], [fullName.slice(0, slash + 1)]),
			fullName.slice(slash + 1),
		],
	)
}

export const metaItem = <M>(
	h: HtmlBuilder<M>,
	name: IconName | null,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.span(
		[h.Class("inline-flex min-w-0 items-center gap-1.5")],
		[
			...(name === null ? [] : [icon(h, name, { size: 14, className: "text-muted-foreground" })]),
			...children,
		],
	)
