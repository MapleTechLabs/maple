import { Option } from "effect"
import type { Html } from "foldkit/html"

// The filter and right sidebars below `lg`: each renders as a sheet, not an
// inline rail, and puts a trigger in the top bar while one is mounted. The page always renders the
// inline rails (`page/kit/dashboard-page.ts`); the shell lifts them out of the body here.

type VNode = NonNullable<Html>
type Child = VNode | string

const slotOf = (node: Child): string | undefined =>
	typeof node === "string" ? undefined : node.data?.attrs?.["data-slot"]?.toString()

/** The rails' children, already built in the page's boundary, so their Messages stay the page's. */
export type LiftedRail = Readonly<{ children: ReadonlyArray<Html> }>

export type SplitPage = Readonly<{
	body: Html
	maybeFilters: Option.Option<LiftedRail>
	maybeRight: Option.Option<LiftedRail>
}>

const railOf = (children: ReadonlyArray<Child>, slot: string): Option.Option<LiftedRail> =>
	Option.map(Option.fromNullishOr(children.find((child) => slotOf(child) === slot)), (rail) => ({
		children: typeof rail === "string" ? [] : (rail.children ?? []).filter(isNode),
	}))

const isNode = (child: Child): child is VNode => typeof child !== "string"

type Lifted = SplitPage & Readonly<{ body: VNode }>

/** Depth-first down to `page-body` (a page may wrap it), rebuilding only the path to it. */
const liftFrom = (node: VNode, depth: number): Option.Option<Lifted> => {
	const children = node.children ?? []
	if (slotOf(node) === "page-body") {
		const isRail = (child: Child) => {
			const slot = slotOf(child)
			return slot === "page-filter-sidebar" || slot === "page-right-sidebar"
		}
		return Option.some({
			body: { ...node, children: children.filter((child) => !isRail(child)) },
			maybeFilters: railOf(children, "page-filter-sidebar"),
			maybeRight: railOf(children, "page-right-sidebar"),
		})
	}
	if (depth === 0) return Option.none()
	return Option.firstSomeOf(
		children.map((child, index) =>
			typeof child === "string"
				? Option.none()
				: Option.map(liftFrom(child, depth - 1), (split) => ({
						...split,
						body: {
							...node,
							children: children.map((other, at) => (at === index ? split.body : other)),
						},
					})),
		),
	)
}

const NO_RAILS = { maybeFilters: Option.none(), maybeRight: Option.none() } as const

/** Takes the page's rails out of its body; a page without `page-body` is returned as it is. */
export const splitPageRails = (page: Html): SplitPage =>
	page === null
		? { body: page, ...NO_RAILS }
		: Option.getOrElse(liftFrom(page, 4), () => ({ body: page, ...NO_RAILS }))
