import type {
	DependencyFindingView,
	DependencyProductionCoverage,
	DependencyScanRepository,
} from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { stripClass } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import {
	dependenciesHref,
	type Digest,
	digestOf,
	EXPANSION_ROWS,
	MATRIX_COLUMNS,
	type PackageRow,
	SEVERITY_LABEL,
	scannedCount,
	type UpgradeStep,
} from "./derive"
import { Message, type Model } from "./model"
import { cleanState, findingsSection, productionHint, readEverything } from "./view-findings"
import { paneTabs, scopeSwitcher } from "./view-pane"
import { advisoryDot, repositoriesPanel, severityTally } from "./view-repositories"
import { firstScan } from "./view-states"

// Every repository at once: each vulnerable package a row and the riskiest repositories a column,
// a dot where the package is open; the rest are counted. A row opens to every repository it is in.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const shortName = (fullName: string): string => fullName.slice(fullName.indexOf("/") + 1)

/** Production can only fade a dot when some service reports the commit it runs. */
const isReachKnown = (production: DependencyProductionCoverage): boolean =>
	production.available && production.linkedServices > 0

const advisoryCount = (step: UpgradeStep): string =>
	countLabel(step.fixes.length + step.unfixed.length, "advisory", "advisories")

const reachOf = (step: UpgradeStep): string =>
	step.services.length === 0 ? "not seen running" : `runs in ${step.services.join(", ")}`

const cellLabel = (row: PackageRow, repository: DependencyScanRepository, step: UpgradeStep): string =>
	[
		`${row.packageName} in ${repository.fullName}`,
		SEVERITY_LABEL[step.severity],
		advisoryCount(step),
		reachOf(step),
	].join(", ")

const dotOf = (h: H, step: UpgradeStep, reachKnown: boolean): Html =>
	advisoryDot(h, step.severity, cn(reachKnown && step.productionSpans === 0 && "opacity-40"))

const cell = (h: H, row: PackageRow, repository: DependencyScanRepository, reachKnown: boolean): Html => {
	const step = row.steps.get(repository.id)
	return tableCell(
		h,
		step === undefined
			? []
			: [
					h.a(
						[
							h.Href(dependenciesHref(repository.id)),
							h.AriaLabel(cellLabel(row, repository, step)),
							h.Title(cellLabel(row, repository, step)),
							h.Class(
								"inline-flex size-6 items-center justify-center rounded-sm hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none",
							),
						],
						[dotOf(h, step, reachKnown)],
					),
				],
		"text-center",
	)
}

const packageCell = (h: H, row: PackageRow, isExpanded: boolean): Html =>
	tableCell(
		h,
		[
			pressable(
				h,
				{
					onClick: Message.ClickedPackage({ key: row.key }),
					className: "flex min-w-0 max-w-64 items-center gap-2 text-left",
					attributes: [h.AriaExpanded(isExpanded)],
				},
				[
					icon(h, isExpanded ? "ChevronDownIcon" : "ChevronRightIcon", {
						size: 12,
						className: "shrink-0 text-muted-foreground",
					}),
					vstack(h, { gap: "0", shrink: true }, [
						typography(h, { size: "sm", mono: true, truncate: true }, [row.packageName]),
						typography(h, { size: "xs", tone: "muted" }, [row.ecosystem]),
					]),
				],
			),
		],
		"sticky left-0 z-10 bg-card",
	)

/** The repositories the package is open in, worst first, with the bump each one needs. */
const expansion = (
	h: H,
	row: PackageRow,
	repositories: ReadonlyMap<string, DependencyScanRepository>,
	options: Readonly<{ reachKnown: boolean; span: number; isFull: boolean }>,
): Html => {
	const steps = [...row.steps.values()]
	const shown = options.isFull ? steps : steps.slice(0, EXPANSION_ROWS)
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.ul(
						[h.Class("flex w-0 min-w-full flex-col gap-1.5 py-1 pl-5")],
						shown.map((step) =>
							h.li(
								[
									h.Key(step.key),
									h.Class("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs"),
								],
								[
									dotOf(h, step, options.reachKnown),
									textLink(
										h,
										{
											href: dependenciesHref(step.repositoryId),
											className: "w-48 truncate",
										},
										[repositories.get(step.repositoryId)?.fullName ?? step.repositoryId],
									),
									typography(h, { mono: true, numeric: true, tone: "muted" }, [
										step.target === null
											? `${step.installed.join(", ")}, no fix yet`
											: `${step.installed.join(", ")} → ${step.target}`,
									]),
									typography(h, { tone: "muted" }, [
										`${advisoryCount(step)} · ${reachOf(step)}`,
									]),
								],
							),
						),
					),
					...(shown.length === steps.length
						? []
						: [
								textLink(
									h,
									{
										tone: "muted",
										className: "ml-5 text-xs",
										onClick: Message.ClickedShowAllRepositories({ key: row.key }),
									},
									[`Show all ${countLabel(steps.length, "repository", "repositories")}`],
								),
							]),
				],
				"bg-surface-sunken whitespace-normal",
				[h.Colspan(options.span)],
			),
		],
		undefined,
		[h.Key(`${row.key}/repositories`)],
	)
}

/** How many repositories have the package, and how many of them run it: the numbers that hold at any size. */
const countCell = (h: H, count: number): Html =>
	tableCell(
		h,
		[
			typography(
				h,
				{ size: "sm", mono: true, numeric: true, tone: count === 0 ? "muted" : "foreground" },
				[String(count)],
			),
		],
		"text-right",
	)

const runningCount = (row: PackageRow): number =>
	[...row.steps.values()].filter((step) => step.productionSpans > 0).length

const columnHead = (h: H, repository: DependencyScanRepository): Html =>
	tableHead(
		h,
		[
			h.a(
				[
					h.Href(dependenciesHref(repository.id)),
					h.AriaLabel(repository.fullName),
					h.Title(repository.fullName),
					h.Class(
						"inline-block max-w-20 truncate align-bottom hover:text-foreground active:text-foreground",
					),
				],
				[shortName(repository.fullName)],
			),
		],
		"w-20 text-center",
	)

const matrixTable = (h: H, model: Model, digest: Digest, reachKnown: boolean): Html => {
	const columns = digest.affected.slice(0, MATRIX_COLUMNS)
	const byId = new Map(digest.repositories.map((repository) => [repository.id, repository] as const))
	const span = columns.length + (reachKnown ? 4 : 3)
	return table(h, { variant: "bare", ariaLabel: "Vulnerable packages by repository" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Package"], "sticky left-0 z-10 bg-card"),
				tableHead(h, ["Fix to"], "w-24 text-right"),
				tableHead(h, ["Repos"], "w-16 text-right", [h.Title("Repositories the package is open in")]),
				...(reachKnown
					? [
							tableHead(h, ["In prod"], "w-16 text-right", [
								h.Title("Of them, the ones running in production"),
							]),
						]
					: []),
				...columns.map((repository) => columnHead(h, repository)),
			]),
		]),
		tableBody(
			h,
			digest.packages.flatMap((row) => {
				const isExpanded = model.expandedPackages.includes(row.key)
				return [
					tableRow(
						h,
						[
							packageCell(h, row, isExpanded),
							tableCell(
								h,
								[
									row.target === null
										? typography(h, { size: "xs", tone: "muted" }, ["No fix yet"])
										: typography(h, { size: "xs", mono: true, numeric: true }, [
												row.target,
											]),
								],
								"text-right",
							),
							countCell(h, row.steps.size),
							...(reachKnown ? [countCell(h, runningCount(row))] : []),
							...columns.map((repository) => cell(h, row, repository, reachKnown)),
						],
						undefined,
						[h.Key(row.key)],
					),
					...(isExpanded
						? [
								expansion(h, row, byId, {
									reachKnown,
									span,
									isFull: model.fullPackages.includes(row.key),
								}),
							]
						: []),
				]
			}),
		),
	])
}

const legend = (h: H, reachKnown: boolean, rest: number): ReadonlyArray<Html> => {
	const parts = [
		...(reachKnown ? ["Solid: runs in production. Faded: not seen running."] : []),
		...(rest > 0
			? [`The ${MATRIX_COLUMNS} riskiest repositories have a column; open a package for the others.`]
			: []),
	]
	return parts.length === 0
		? []
		: [
				typography(h, { size: "xs", tone: "muted", as: "p", className: stripClass("foot") }, [
					parts.join(" "),
				]),
			]
}

const matrixPanel = (h: H, model: Model, digest: Digest, production: DependencyProductionCoverage): Html => {
	if (digest.packages.length === 0)
		return digest.repositories.every(readEverything)
			? cleanState(h, digest.repositories)
			: panel(h, {}, [emptyMessage(h, {}, ["No open advisories in the latest scans"])])
	const reachKnown = isReachKnown(production)
	return panel(h, { className: "overflow-hidden" }, [
		...productionHint(h, production),
		h.div([h.Class("overflow-x-auto")], [matrixTable(h, model, digest, reachKnown)]),
		...legend(h, reachKnown, digest.affected.length - MATRIX_COLUMNS),
	])
}

/** A repository whose latest scan missed something, so the matrix is not read as its whole story. */
const hasScanProblem = (repository: DependencyScanRepository): boolean => {
	const scan = repository.latestScan
	return (
		scan !== null &&
		(scan.error !== null ||
			scan.status === "failed" ||
			scan.lockfiles.some((lockfile) => lockfile.status !== "parsed"))
	)
}

/** One line however many there are; the Repositories tab names them. */
const scanProblems = (h: H, repositories: ReadonlyArray<DependencyScanRepository>): ReadonlyArray<Html> => {
	const count = repositories.filter(hasScanProblem).length
	return count === 0
		? []
		: [
				hstack(h, { gap: "2", wrap: true }, [
					icon(h, "CircleWarningIcon", { size: 14, className: "shrink-0 text-severity-warn" }),
					typography(h, { size: "xs", tone: "muted" }, [
						`${countLabel(count, "repository", "repositories")} could not be read in full.`,
					]),
					textLink(h, { href: dependenciesHref(null, "repositories"), className: "text-xs" }, [
						"See which",
					]),
				]),
			]
}

/** Every repository: the switcher, the open findings by severity, then the matrix, repositories or advisories. */
export const allRepositoriesPane = (
	h: H,
	model: Model,
	state: Readonly<{
		repositories: ReadonlyArray<DependencyScanRepository>
		findings: ReadonlyArray<DependencyFindingView>
		production: DependencyProductionCoverage
	}>,
	clock: Clock,
): ReadonlyArray<Html> => {
	const { repositories, findings, production } = state
	const digest = digestOf(repositories, findings)
	const switcher = scopeSwitcher(h, model, digest, [
		typography(h, { size: "xs", tone: "muted" }, [
			`${countLabel(digest.open, "open advisory", "open advisories")} in ${digest.affected.length} of ${countLabel(repositories.length, "repository", "repositories")}. ${scannedCount(repositories)} / ${repositories.length} scanned.`,
		]),
	])
	const hasScans = scannedCount(repositories) > 0
	return [
		switcher,
		// Before any scan there is nothing to count: say the first one is coming.
		...(hasScans
			? [severityTally(h, findings), ...scanProblems(h, repositories)]
			: [firstScan(h, model, repositories)]),
		paneTabs(h, null, model.pane, {
			summary: { label: "Packages", count: digest.packages.length },
			repositories: repositories.length,
			advisories: digest.open,
		}),
		model.pane === "summary"
			? // Nothing to chart yet, so the packages view is each repository with its Scan now.
				hasScans
				? matrixPanel(h, model, digest, production)
				: repositoriesPanel(h, model, digest, clock)
			: model.pane === "repositories"
				? repositoriesPanel(h, model, digest, clock)
				: findingsSection(h, model, state, clock),
	]
}
