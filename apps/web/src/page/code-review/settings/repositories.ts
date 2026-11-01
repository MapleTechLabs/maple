import type { GithubRepoSummary } from "@maple/domain/http"
import {
	type RepositoryFilter,
	SEARCH_THRESHOLD,
	visibleRepositories,
} from "../../../components/code-review/repository-filter"
import { pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { panel, panelHeader } from "../../../ui/panel"
import { segmentedSelect } from "../../../ui/segmented-select"
import * as Switch from "../../../ui/switch"
import { searchInput } from "../../../ui/search-input"

// `RepositoryList`, `RepositoryRow` and `RepositoryName`, shared with
// `/lab/code-review-repos`.

export const RepoFilter = Schema.Literals(["all", "reviewed", "off"])

/** The list's own state: the search, the review filter and the rows pinned first on mount. */
export const RepoListState = Schema.Struct({
	search: Schema.String,
	filter: RepoFilter,
	/** Reviewed repositories lead, ranked once so a row does not jump away when toggled. */
	pinned: Schema.NullOr(Schema.Array(Schema.String)),
})
export type RepoListState = typeof RepoListState.Type

export const initRepoList = (): RepoListState => ({ search: "", filter: "all", pinned: null })

/** Pins the reviewed repositories the first time the list has rows. */
export const pinOnce = (
	state: RepoListState,
	repositories: ReadonlyArray<GithubRepoSummary>,
): RepoListState =>
	state.pinned === null
		? { ...state, pinned: repositories.filter((repo) => repo.prReviewEnabled).map((repo) => repo.id) }
		: state

const FILTER_LABELS = {
	all: "All",
	reviewed: "Reviewed",
	off: "Not reviewed",
} satisfies Record<RepositoryFilter, string>

export type RepoListOptions<M> = Readonly<{
	repositories: ReadonlyArray<GithubRepoSummary>
	state: RepoListState
	isAdmin: boolean
	busy: ReadonlyArray<string>
	/** The row's switch (optimistic); counts and the filter read the server's value. */
	isEnabled: (repo: GithubRepoSummary) => boolean
	onSearch: (value: string) => M
	onFilter: (filter: RepositoryFilter) => M
	onShowAll: M
	onToggle: (repo: GithubRepoSummary) => M
	onConfigure: (repo: GithubRepoSummary) => M
}>

/** The list header's way to the GitHub App's repository access. */
export const manageAccessLink = <M>(h: HtmlBuilder<M>): Html =>
	h.a(
		[
			h.Class(
				"inline-flex items-center gap-1 text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground active:decoration-foreground",
			),
			h.Href(hrefOf(AppRoute.SourcesNew({ search: { integration: "github" } }))),
		],
		["Manage GitHub access", icon(h, "ArrowRightIcon", { size: 12, className: "shrink-0" })],
	)

/** The owner recedes so the part that differs between rows, the repository name, carries it. */
const repositoryName = <M>(h: HtmlBuilder<M>, fullName: string): Html => {
	const slash = fullName.indexOf("/")
	return h.span(
		[h.Class("truncate")],
		[
			h.span([h.Class("font-normal text-muted-foreground")], [fullName.slice(0, slash + 1)]),
			fullName.slice(slash + 1),
		],
	)
}

const repositoryRow = <M>(h: HtmlBuilder<M>, repo: GithubRepoSummary, options: RepoListOptions<M>): Html => {
	const id = `code-review-repo-${repo.id}`
	const isEnabled = options.isEnabled(repo)
	return h.li(
		[h.Key(repo.id), h.Class("flex items-center gap-3 px-5 py-2.5")],
		[
			icon(h, "GithubIcon", { size: 16, className: "shrink-0 text-muted-foreground" }),
			h.div(
				[h.Class("flex min-w-0 flex-1 items-center gap-2")],
				[
					h.a(
						[
							h.Class(
								"group inline-flex min-w-0 items-center gap-1 text-sm font-medium hover:underline active:underline",
							),
							h.Href(repo.htmlUrl),
							h.Attribute("rel", "noreferrer"),
							h.Attribute("target", "_blank"),
						],
						[
							repositoryName(h, repo.fullName),
							icon(h, "ExternalLinkIcon", {
								size: 12,
								className:
									"shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
							}),
						],
					),
					...(repo.isPrivate
						? [badge(h, { variant: "outline", size: "sm", className: "shrink-0" }, ["Private"])]
						: []),
				],
			),
			button(
				h,
				{
					size: "sm",
					variant: "ghost",
					className: "shrink-0 text-muted-foreground",
					isDisabled: !isEnabled,
					attributes: [
						h.Title(
							isEnabled
								? "Repository overrides"
								: "Turn reviews on to configure this repository",
						),
						h.OnClick(options.onConfigure(repo)),
					],
				},
				[icon(h, "GearIcon"), "Configure"],
			),
			...Switch.switchControl(h, {
				id: `${id}-switch`,
				inputId: id,
				isChecked: isEnabled,
				isDisabled: !options.isAdmin,
				ariaLabel: `Review pull requests on ${repo.fullName}`,
				// Ignored while a change is in flight, rather than disabled, which would drop focus.
				onToggle: options.busy.includes(repo.id) ? undefined : options.onToggle(repo),
			}),
		],
	)
}

const searchBox = <M>(h: HtmlBuilder<M>, options: RepoListOptions<M>): Html =>
	searchInput(h, {
		id: "code-review-repo-search",
		size: "sm",
		className: "min-w-48 flex-1",
		placeholder: "Search repositories…",
		value: options.state.search,
		onInput: options.onSearch,
		onClear: options.onSearch(""),
		attributes: [h.AriaLabel("Search repositories")],
	})

/** About as many rows as the list's max height shows before it scrolls. */
const FOLD_ROWS = 11

export const repositoryList = <M>(h: HtmlBuilder<M>, options: RepoListOptions<M>): Html => {
	const { repositories, state } = options
	const enabled = repositories.filter((repo) => repo.prReviewEnabled).length
	const counts = { all: repositories.length, reviewed: enabled, off: repositories.length - enabled }
	const showToolbar = repositories.length > SEARCH_THRESHOLD
	const visible = visibleRepositories(repositories, {
		search: state.search,
		filter: state.filter,
		pinned: new Set(state.pinned ?? []),
	})
	const isSearching = showToolbar && state.search.trim().length > 0
	return panel(h, {}, [
		panelHeader(h, {
			className: "px-5 py-3 text-xs text-muted-foreground",
			action: manageAccessLink(h),
			children: [
				h.span(
					[],
					[
						String(enabled),
						" of ",
						String(repositories.length),
						" ",
						pluralize(repositories.length, "repository", "repositories"),
						" reviewed",
					],
				),
			],
		}),
		...(showToolbar
			? [
					h.div(
						[h.Class("flex flex-wrap items-center gap-3 border-b px-5 py-3")],
						[
							searchBox(h, options),
							segmentedSelect<RepositoryFilter, M>(h, {
								size: "sm",
								ariaLabel: "Review status",
								value: state.filter,
								onChange: options.onFilter,
								options: (["all", "reviewed", "off"] as const).map((value) => ({
									value,
									label: `${FILTER_LABELS[value]} · ${counts[value]}`,
								})),
							}),
						],
					),
				]
			: []),
		visible.length === 0
			? h.div(
					[
						h.Class(
							"flex flex-col items-center gap-2 px-5 py-10 text-center text-sm text-muted-foreground",
						),
					],
					[
						h.p(
							[],
							[
								isSearching
									? `No repositories match “${state.search.trim()}”`
									: state.filter === "reviewed"
										? "No repositories are reviewed yet"
										: "Every repository is reviewed",
							],
						),
						button(
							h,
							{ size: "sm", variant: "ghost", attributes: [h.OnClick(options.onShowAll)] },
							["Show all repositories"],
						),
					],
				)
			: h.ul(
					[
						h.Class(
							cn(
								"max-h-[min(36rem,65vh)] divide-y overflow-y-auto",
								// A long list fades at the fold; the padding clears the last row once scrolled to it.
								visible.length > FOLD_ROWS &&
									"pb-6 [mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]",
							),
						),
					],
					visible.map((repo) => repositoryRow(h, repo, options)),
				),
		...(visible.length > 0 && visible.length < repositories.length
			? [
					h.div(
						[h.Class("border-t px-5 py-2 text-xs text-muted-foreground")],
						["Showing ", String(visible.length), " of ", String(repositories.length)],
					),
				]
			: []),
	])
}
