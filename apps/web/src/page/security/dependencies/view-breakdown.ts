import type {
	DependencyFindingView,
	DependencyProductionCoverage,
	DependencyScanRepository,
} from "@maple/domain/http"
import { displayAdvisoryId } from "@maple/domain/package-advisories"
import { countLabel, formatRate } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../../ui/empty"
import { middleTruncate } from "../../../ui/middle-truncate"
import { panel, panelHeader } from "../../../ui/panel"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { textLink } from "../../../ui/text-link"
import { repositoryName } from "../kit/parts"
import { planSummaryOf, RELATION_LABEL, type UpgradeStep, upgradePlanOf } from "./derive"
import type { Message } from "./model"
import { dependencySeverityBadge, notRunningLabel, productionScanStates } from "./view-findings"
import { repositoryHref } from "./view-repositories"

// One repository's open findings as the package bumps that clear them, the first to make on top.

type H = HtmlBuilder<Message>

const muted = (h: H, text: string, className = ""): Html =>
	h.span([h.Class(`text-xs text-muted-foreground ${className}`)], [text])

const advisoryNames = (findings: ReadonlyArray<DependencyFindingView>): string =>
	findings
		.map((finding) => displayAdvisoryId({ id: finding.advisoryId, aliases: finding.aliases }))
		.join(", ")

const bumpCell = (h: H, step: UpgradeStep): Html =>
	h.span(
		[h.Class("flex min-w-0 max-w-72 flex-col")],
		[
			h.span([h.Class("truncate font-mono text-sm"), h.Title(step.packageName)], [step.packageName]),
			h.span(
				[h.Class("flex min-w-0 items-center gap-1.5 font-mono text-xs tabular-nums")],
				[
					h.span(
						[h.Class("truncate text-muted-foreground"), h.Title(step.installed.join(", "))],
						[step.installed.join(", ")],
					),
					...(step.target === null
						? []
						: [
								h.span([h.AriaHidden(true), h.Class("text-foreground-faint")], ["→"]),
								h.span([h.Class("shrink-0 text-foreground")], [step.target]),
							]),
				],
			),
		],
	)

const clearsCell = (h: H, step: UpgradeStep): Html =>
	h.span(
		[h.Class("flex flex-col")],
		[
			h.span(
				[h.Class("whitespace-nowrap text-sm"), h.Title(advisoryNames(step.fixes))],
				[
					step.target === null
						? "No fix yet"
						: countLabel(step.fixes.length, "advisory", "advisories"),
				],
			),
			...(step.unfixed.length === 0 || step.target === null
				? []
				: [muted(h, `${step.unfixed.length} with no fix yet`)]),
		],
	)

const runningCell = (h: H, step: UpgradeStep, notRunning: string): Html => {
	const [busiest] = step.services
	return busiest === undefined
		? muted(h, notRunning)
		: h.span(
				[h.Class("flex min-w-0 max-w-48 flex-col"), h.Title(step.services.join(", "))],
				[
					h.span(
						[h.Class("truncate text-sm")],
						[step.services.length > 1 ? `${busiest} +${step.services.length - 1}` : busiest],
					),
					muted(h, `${formatRate(step.productionSpans)} spans/day`, "tabular-nums"),
				],
			)
}

const stepRow = (h: H, step: UpgradeStep, notRunning: string): Html =>
	tableRow(
		h,
		[
			tableCell(h, [dependencySeverityBadge(h, step.severity)], "w-24"),
			tableCell(h, [bumpCell(h, step)]),
			tableCell(h, [clearsCell(h, step)]),
			tableCell(h, [runningCell(h, step, notRunning)]),
			tableCell(h, [muted(h, RELATION_LABEL[step.relation])], "hidden md:table-cell"),
			tableCell(
				h,
				[
					h.span(
						[h.Class("flex min-w-0 max-w-56 flex-col"), h.Title(step.lockfiles.join("\n"))],
						[
							middleTruncate(h, {
								text: step.lockfiles[0] ?? "",
								tail: Math.min(24, step.lockfiles[0]?.length ?? 0),
								mono: true,
								className: "text-xs text-muted-foreground",
							}),
							...(step.lockfiles.length > 1
								? [muted(h, `+${countLabel(step.lockfiles.length - 1, "lockfile")}`)]
								: []),
						],
					),
				],
				"hidden lg:table-cell",
			),
		],
		undefined,
		[h.Key(step.key)],
	)

/** "3 upgrades clear 5 of 6 open advisories": the plan before its rows. */
const planLine = (plan: ReadonlyArray<UpgradeStep>): string => {
	const summary = planSummaryOf(plan)
	const clears =
		summary.upgrades === 0
			? `None of ${countLabel(summary.open, "open advisory", "open advisories")} has a fixed version yet.`
			: `${countLabel(summary.upgrades, "upgrade")} ${summary.upgrades === 1 ? "clears" : "clear"} ${summary.fixable} of ${countLabel(summary.open, "open advisory", "open advisories")}.`
	if (summary.upgrades === 0 || summary.unfixed === 0) return clears
	return `${clears} ${summary.unfixed} still ${summary.unfixed === 1 ? "waits" : "wait"} on a fix upstream.`
}

export const repositoryBreakdown = (
	h: H,
	repository: DependencyScanRepository,
	findings: ReadonlyArray<DependencyFindingView>,
	production: DependencyProductionCoverage,
): Html => {
	const plan = upgradePlanOf(findings.filter((finding) => finding.repositoryId === repository.id))
	const notRunning = notRunningLabel(production, productionScanStates([repository]).get(repository.id))
	return panel(h, { className: "overflow-hidden" }, [
		panelHeader(h, {
			title: h.span(
				[h.Class("flex min-w-0 items-baseline gap-2")],
				[
					repositoryName(h, repository.fullName),
					h.span([h.Class("text-muted-foreground")], ["Upgrade plan"]),
				],
			),
			action: textLink(h, { tone: "muted", className: "text-xs", href: repositoryHref(null) }, [
				"All repositories",
			]),
		}),
		...(plan.length === 0
			? [emptyMessage(h, {}, ["No open advisories in this repository's latest scan."])]
			: [
					h.p([h.Class("border-b px-4 py-2 text-xs text-muted-foreground")], [planLine(plan)]),
					table(h, { variant: "bare", ariaLabel: `Upgrade plan for ${repository.fullName}` }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Worst"]),
								tableHead(h, ["Upgrade"]),
								tableHead(h, ["Clears"]),
								tableHead(h, ["Running in"]),
								tableHead(h, ["Relation"], "hidden md:table-cell"),
								tableHead(h, ["Lockfile"], "hidden lg:table-cell"),
							]),
						]),
						tableBody(
							h,
							plan.map((step) => stepRow(h, step, notRunning)),
						),
					]),
				]),
	])
}
