import type { VcsRepositoryId } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { textLink } from "@maple/views/ui/text-link"
import { AppRoute, hrefOf } from "../../../route"
import { authorLabel } from "./author"
import type { WindowSearch } from "./frame"

// A person or repository anywhere in Code Review links to its pull requests, in the same window.

/** What a link keeps from the page it is on: the window, and the filter it does not replace. */
export type LinkScope = WindowSearch & Readonly<{ repo?: VcsRepositoryId; author?: string }>

const windowOf = (scope: LinkScope): WindowSearch => ({
	startTime: scope.startTime,
	endTime: scope.endTime,
	timePreset: scope.timePreset,
})

/** The Pull requests tab filtered to one author, still on the page's repository. */
export const authorHref = (login: string, scope: LinkScope = {}): string =>
	hrefOf(
		AppRoute.CodeReviewPullRequests({ search: { ...windowOf(scope), repo: scope.repo, author: login } }),
	)

/** The Pull requests tab filtered to one repository, still on the page's author. */
export const repositoryHref = (repo: VcsRepositoryId, scope: LinkScope = {}): string =>
	hrefOf(AppRoute.CodeReviewPullRequests({ search: { ...windowOf(scope), author: scope.author, repo } }))

export type LinkOptions = Readonly<{
	scope?: LinkScope
	/** On the link: width and type size. */
	className?: string
}>

/** `authorLabel` as a link to the person's pull requests. */
export const authorLink = <M>(h: HtmlBuilder<M>, login: string, options: LinkOptions = {}): Html =>
	textLink(
		h,
		{
			href: authorHref(login, options.scope),
			tone: "inherit",
			className: cn("min-w-0", options.className),
		},
		[authorLabel(h, login, "max-w-full")],
	)

/**
 * A repository's label as a link to its pull requests; the label alone without an id (a name the
 * integration no longer lists), since the filter takes the id.
 */
export const repositoryLink = <M>(
	h: HtmlBuilder<M>,
	repo: VcsRepositoryId | undefined,
	label: Html,
	options: LinkOptions = {},
): Html =>
	repo === undefined
		? label
		: textLink(
				h,
				{
					href: repositoryHref(repo, options.scope),
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
