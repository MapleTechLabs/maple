import type { DependencyFindingView, DependencyScanRepository } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "../../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { textLink } from "../../../ui/text-link"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { placeholder } from "../kit/parts"
import { openSeverityCounts, scannedCount } from "./derive"
import type { Message, Model } from "./model"
import { scanButton } from "./view-repositories"

// The Dependencies tab's rail and its whole-tab states: loading, no GitHub, first scan pending.

type H = HtmlBuilder<Message>

export const dependenciesLoading = (h: H): ReadonlyArray<Html> => [
	h.div(
		[h.AriaBusy(true), h.AriaLabel("Loading"), h.Class("grid grid-cols-2 gap-px md:grid-cols-5")],
		Array.from({ length: 5 }, () => placeholder(h, "h-24")),
	),
	placeholder(h, "h-32 w-full"),
	placeholder(h, "h-64 w-full"),
]

/** No connected repository: the GitHub on-ramp the code audits use. */
export const notConnected = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "GithubIcon")]),
				emptyTitle(h, ["Connect a repository to scan its dependencies"]),
				emptyDescription(h, [
					"Maple reads the lockfiles on each repository's tracked branch, matches every package against OSV.dev and rescans on every push.",
				]),
			]),
			emptyContent(h, [
				linkButton(h, { href: hrefOf(AppRoute.Integrations({ search: {} })) }, [
					icon(h, "GithubIcon"),
					"Connect GitHub",
				]),
				h.p(
					[h.Class("text-xs text-muted-foreground")],
					["npm, pnpm, Yarn, Bun, Go and Cargo lockfiles. Read-only, code is never executed."],
				),
			]),
		],
		"rounded-md border md:py-16",
	)

/** Connected, never scanned: the first scan follows the connection or the next push. */
export const firstScan = (
	h: H,
	model: Model,
	repositories: ReadonlyArray<DependencyScanRepository>,
): Html => {
	const only = repositories.length === 1 ? (repositories[0] ?? null) : null
	return empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CubeIcon")]),
				emptyTitle(h, ["First scan is on its way"]),
				emptyDescription(h, [
					"Each connected repository is scanned shortly after it is connected and again on every push to its tracked branch.",
				]),
			]),
			...(only === null ? [] : [emptyContent(h, [scanButton(h, model, only)])]),
		],
		"rounded-md border md:py-14",
	)
}

export const severityRail = (
	h: H,
	findings: ReadonlyArray<DependencyFindingView>,
	repositories: ReadonlyArray<DependencyScanRepository>,
): Html => {
	const counts = openSeverityCounts(findings)
	return statRail(h, { columns: 5 }, [
		statRailItem(h, {
			eyebrow: "Critical",
			value: String(counts.critical),
			tone: counts.critical > 0 ? "crit" : undefined,
			compact: true,
			subline: "open, fix first",
		}),
		statRailItem(h, {
			eyebrow: "High",
			value: String(counts.high),
			tone: counts.high > 0 ? "warn" : undefined,
			compact: true,
			subline: "open",
		}),
		statRailItem(h, { eyebrow: "Medium", value: String(counts.medium), compact: true, subline: "open" }),
		statRailItem(h, {
			eyebrow: "Low",
			value: String(counts.low),
			compact: true,
			subline: counts.unknown > 0 ? `open, and ${counts.unknown} unrated` : "open",
		}),
		statRailItem(h, {
			eyebrow: "Repositories",
			value: `${scannedCount(repositories)} / ${repositories.length}`,
			compact: true,
			subline: "scanned / connected",
		}),
	])
}

export const footnote = (h: H): Html =>
	h.p(
		[h.Class("text-xs text-muted-foreground")],
		[
			"Advisories from ",
			textLink(
				h,
				{
					tone: "muted",
					className: "underline",
					href: "https://osv.dev",
					attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
				},
				["OSV.dev"],
			),
			". Findings are kept per lockfile and package, and marked fixed when a scan no longer finds them.",
		],
	)
