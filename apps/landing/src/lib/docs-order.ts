/**
 * Docs in reading order, grouped.
 *
 * `/docs.md`, `/llms-full.txt` and prev/next all need "every doc, in the
 * order the sidebar shows them". Kept out of `docs-nav.ts` on purpose: that
 * module is imported by client islands, and `astro:content` must not follow
 * it into a browser bundle.
 */
import { getCollection, type CollectionEntry } from "astro:content"
import { SECTIONS, groupRank, sectionForGroup } from "./docs-nav"

export type Doc = CollectionEntry<"docs">

/** Every non-draft doc, grouped and ordered the way the sidebar orders them. */
export async function getDocGroups(): Promise<{ group: string; docs: Doc[] }[]> {
	const docs = await getCollection("docs", ({ data }) => !data.draft)

	const groups = new Map<string, Doc[]>()
	for (const doc of docs) {
		const bucket = groups.get(doc.data.group)
		if (bucket) bucket.push(doc)
		else groups.set(doc.data.group, [doc])
	}

	return [...groups.entries()]
		.sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b))
		.map(([group, items]) => ({
			group,
			docs: items.sort(
				(a, b) => a.data.order - b.data.order || a.data.title.localeCompare(b.data.title),
			),
		}))
}

export type NavRow = { doc: Doc; children: Doc[]; open: boolean }
export type NavGroup = { group: string; rows: NavRow[] }

// Pages listed under a parent row instead of in their own group. `open` keeps
// the children visible on every page, not only inside that subtree.
const NESTED: { parent: string; isChild: (doc: Doc) => boolean; open: boolean }[] = [
	{ parent: "sdks/effect", isChild: (d) => d.data.sdk === "effect" && d.id !== "sdks/effect", open: false },
	{ parent: "self-hosting/deploy", isChild: (d) => d.data.group === "Platforms", open: true },
]

/** The sidebar tree: groups in order, rows with their nested children. */
export async function getNavTree(): Promise<NavGroup[]> {
	const groups = await getDocGroups()
	const all = groups.flatMap((g) => g.docs)
	const nesting = NESTED.filter((n) => all.some((d) => d.id === n.parent)).map((n) => ({
		...n,
		children: all.filter(n.isChild),
	}))
	const nested = new Set(nesting.flatMap((n) => n.children.map((d) => d.id)))
	return groups
		.map(({ group, docs }) => ({
			group,
			rows: docs
				.filter((doc) => !nested.has(doc.id))
				.map((doc) => {
					const n = nesting.find((x) => x.parent === doc.id)
					return { doc, children: n?.children ?? [], open: n?.open ?? false }
				}),
		}))
		.filter((g) => g.rows.length > 0)
}

/** Where a page sits in the tree: its sidebar group and, if nested, its parent row. */
export function locate(tree: NavGroup[], slug: string): { group: string; parent: Doc | null } | null {
	for (const { group, rows } of tree) {
		for (const row of rows) {
			if (row.doc.id === slug) return { group, parent: null }
			if (row.children.some((c) => c.id === slug)) return { group, parent: row.doc }
		}
	}
	return null
}

/** Every page in sidebar reading order: each row, then its children. */
export const readingOrder = (tree: NavGroup[]): Doc[] =>
	tree.flatMap((g) => g.rows.flatMap((r) => [r.doc, ...r.children]))

/**
 * The four sidebar sections with what the switchers need: the page count,
 * the first page to open on, and whether `currentSlug` lives inside.
 */
export async function getDocSections(currentSlug: string) {
	const groups = await getDocGroups()
	const currentGroup = groups.find((g) => g.docs.some((d) => d.id === currentSlug))?.group
	const activeId = currentGroup ? sectionForGroup(currentGroup).id : SECTIONS[0].id
	return SECTIONS.map((section) => {
		const docs = groups.filter((g) => sectionForGroup(g.group).id === section.id).flatMap((g) => g.docs)
		const first = docs[0]
		return {
			...section,
			count: docs.length,
			href: first ? `/docs/${first.id}` : "/docs",
			active: section.id === activeId,
		}
	})
}
