import type { AdvisorySeverity } from "@maple/domain/runtime-advisories"
import type { SecurityAuditRunStatus, SecurityAuditSeverity } from "@maple/domain/security-audit"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import {
	empty,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { icon, type IconName } from "@maple/views/ui/icon"
import { severityBadge } from "../../errors/kit/severity"
import { type Gate, issueSeverityOf, runLabelOf, runToneOf, SECURITY_SEVERITY_LABEL } from "./format"
import { String as Str, Option } from "effect"

// Marks and states the Security Center's pages share.

type RunState = Readonly<{ status: SecurityAuditRunStatus; incompleteReason: string | null }>

export const runStatusBadge = <M>(h: HtmlBuilder<M>, run: RunState, detail?: string): Html => {
	const tone = runToneOf(run)
	return badge(h, { variant: tone === "neutral" ? "muted" : tone }, [
		detail === undefined ? runLabelOf(run) : `${runLabelOf(run)} · ${detail}`,
	])
}

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

/** An advisory's severity in the same badge; one with no score reads as "Unrated". */
export const advisorySeverityBadge = <M>(
	h: HtmlBuilder<M>,
	severity: AdvisorySeverity,
	className?: string,
): Html =>
	severity === "unknown"
		? badge(h, { variant: "muted", className: cn("text-muted-foreground", className) }, ["Unrated"])
		: securitySeverityBadge(h, severity, className)

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
		emptyFrameClass("dashed", className),
	)
}

/** `owner/` recedes so the repository name carries the row. */
export const repositoryName = <M>(h: HtmlBuilder<M>, fullName: string, className?: string): Html => {
	const name = Option.match(Str.indexOf("/")(fullName), { onNone: () => 0, onSome: (slash) => slash + 1 })
	return h.span(
		[h.Class(cn("truncate", className)), h.Title(fullName)],
		[
			h.span([h.Class("text-muted-foreground")], [Str.slice(0, name)(fullName)]),
			Str.slice(name)(fullName),
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
