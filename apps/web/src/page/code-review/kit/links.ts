import type { VcsRepositoryId } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { textLink } from "@maple/views/ui/text-link"
import { AppRoute, hrefOf } from "../../../route"
import { authorLabel } from "./author"
import type { WindowSearch } from "./frame"

// A person or repository anywhere in Code Review links to its pull requests, in the same window.

const windowOf = (window: WindowSearch): WindowSearch => ({
	startTime: window.startTime,
	endTime: window.endTime,
	timePreset: window.timePreset,
})

/** The Pull requests tab filtered to one author. */
export const authorHref = (login: string, window: WindowSearch = {}): string =>
	hrefOf(AppRoute.CodeReviewPullRequests({ search: { ...windowOf(window), author: login } }))

/** The Pull requests tab filtered to one repository. */
export const repositoryHref = (repo: VcsRepositoryId, window: WindowSearch = {}): string =>
	hrefOf(AppRoute.CodeReviewPullRequests({ search: { ...windowOf(window), repo } }))

export type AuthorLinkOptions = Readonly<{
	window?: WindowSearch
	/** On the link: width and type size, as `authorLabel` takes them. */
	className?: string
}>

/** `authorLabel` as a link to the person's pull requests. */
export const authorLink = <M>(h: HtmlBuilder<M>, login: string, options: AuthorLinkOptions = {}): Html =>
	textLink(
		h,
		{
			href: authorHref(login, options.window),
			tone: "inherit",
			className: cn("min-w-0", options.className),
		},
		[authorLabel(h, login, "max-w-full")],
	)

/**
 * A repository's label as a link to its pull requests; the label alone when the repository is not
 * one the integration lists (renamed or removed), since the filter takes its id.
 */
export const repositoryLink = <M>(
	h: HtmlBuilder<M>,
	repo: VcsRepositoryId | undefined,
	label: Html | string,
	options: Readonly<{ window?: WindowSearch; className?: string }> = {},
): Html | string =>
	repo === undefined
		? label
		: textLink(
				h,
				{
					href: repositoryHref(repo, options.window),
					tone: "inherit",
					className: cn("min-w-0", options.className),
				},
				[label],
			)

/** For a click target inside a clickable row: filters the list in place, the row's click left alone. */
export const inRowFilterLink = <M>(
	h: HtmlBuilder<M>,
	onClick: M,
	children: ReadonlyArray<Html | string>,
	className?: string,
): Html =>
	textLink(
		h,
		{
			onClick,
			clickOptions: { propagation: "Stop" },
			tone: "inherit",
			className: cn("min-w-0 text-left", className),
		},
		children,
	)
