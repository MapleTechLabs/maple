import type { GithubRepoSummary } from "@maple/domain/http"
import {
	type RepositoryFilter,
	SEARCH_THRESHOLD,
	visibleRepositories,
} from "../../../components/code-review/repository-filter"
import { pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Schema, Array as Arr, String as Str, Option } from "effect"
import { revealIcon } from "@maple/views/ui/reveal-icon"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import * as Switch from "@maple/views/ui/switch"
import { searchInput } from "@maple/views/ui/search-input"
import { typography } from "@maple/views/ui/typography"

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
		? {
				...state,
				pinned: Arr.map(
					Arr.filter(repositories, (repo) => repo.prReviewEnabled),
					(repo) => repo.id,
				),
			}
		: state

const FILTER_LABELS = {
	all: "All",
	reviewed: "Reviewed",
	off: "Not reviewed",
} satisfies Record<RepositoryFilter, string>

export type RepoListOptions<M> = Readonly<{
	repositories: ReadonlyArray<GithubRepoSummary>
	state: RepoListState
	canEdit: boolean
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
	const cut = Option.match(Str.indexOf("/")(fullName), { onNone: () => 0, onSome: (slash) => slash + 1 })
	return h.span(
		[h.Class("truncate")],
		[
			typography(h, { tone: "muted", weight: "normal" }, [Str.slice(0, cut)(fullName)]),
			Str.slice(cut)(fullName),
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
						[repositoryName(h, repo.fullName), revealIcon(h, "ExternalLinkIcon", { size: 12 })],
					),
					...(repo.isPrivate
						? [
								// Below sm the name needs the room more than the badge does.
								badge(
									h,
									{ variant: "outline", size: "sm", className: "shrink-0 max-sm:hidden" },
									["Private"],
								),
							]
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
						h.AriaLabel(`Configure ${repo.fullName}`),
						h.Title(
							isEnabled
								? "Repository overrides"
								: "Turn reviews on to configure this repository",
						),
						h.OnClick(options.onConfigure(repo)),
					],
				},
				// Icon-only below sm, so a phone row still shows the repository's name.
				[icon(h, "GearIcon"), h.span([h.Class("max-sm:hidden")], ["Configure"])],
			),
			...Switch.switchControl(h, {
				id: `${id}-switch`,
				inputId: id,
				isChecked: isEnabled,
				isDisabled: !options.canEdit,
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
	const enabled = Arr.filter(repositories, (repo) => repo.prReviewEnabled).length
	const counts = { all: repositories.length, reviewed: enabled, off: repositories.length - enabled }
	const showToolbar = repositories.length > SEARCH_THRESHOLD
	const visible = visibleRepositories(repositories, {
		search: state.search,
		filter: state.filter,
		pinned: new Set(state.pinned ?? []),
	})
	const isSearching = showToolbar && Str.trim(state.search).length > 0
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
							// Scrolls on a phone instead of spilling out of the card; the padding keeps the
							// segments' 44px touch targets and focus rings inside the scroll box.
							h.div(
								[h.Class("-my-1.5 max-w-full overflow-x-auto py-1.5 [scrollbar-width:none]")],
								[
									segmentedSelect<RepositoryFilter, M>(h, {
										size: "sm",
										ariaLabel: "Review status",
										value: state.filter,
										onChange: options.onFilter,
										options: Arr.map(["all", "reviewed", "off"] as const, (value) => ({
											value,
											label: `${FILTER_LABELS[value]} · ${counts[value]}`,
										})),
									}),
								],
							),
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
									? `No repositories match “${Str.trim(state.search)}”`
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
					Arr.map(visible, (repo) => repositoryRow(h, repo, options)),
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
