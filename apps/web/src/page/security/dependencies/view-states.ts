import type { DependencyScanRepository } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "@maple/views/ui/button"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { textLink } from "@maple/views/ui/text-link"
import { placeholder } from "../kit/parts"
import type { Message, Model } from "./model"
import { scanButton } from "./view-repositories"
import { typography } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"

// The Dependencies tab's whole-tab states: loading, no GitHub, first scan pending.

type H = HtmlBuilder<Message>

export const dependenciesLoading = (h: H): ReadonlyArray<Html> => [
	vstack(h, { gap: "4", attributes: [h.AriaBusy(true), h.AriaLabel("Loading")] }, [
		placeholder(h, "h-8 w-72"),
		placeholder(h, "h-9 w-full"),
		placeholder(h, "h-80 w-full"),
	]),
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
				typography(h, { size: "xs", tone: "muted", as: "p" }, [
					"npm, pnpm, Yarn, Bun, Go and Cargo lockfiles. Read-only, code is never executed.",
				]),
			]),
		],
		emptyFrameClass("dashed"),
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
		"rounded-md border border-dashed md:py-14",
	)
}

export const footnote = (h: H): Html =>
	typography(h, { size: "xs", tone: "muted", as: "p" }, [
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
	])
