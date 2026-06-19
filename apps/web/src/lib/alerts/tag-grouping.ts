/**
 * Tag filtering + grouping for the alerts list. Shared by the Rules tab (over
 * alert rules) and the Monitor tab (over incidents joined to their rule's tags),
 * so the two surfaces stay consistent. All functions are generic over the item
 * type via a `getTags` accessor.
 */

/** Stable key for the bucket holding items with no tags. */
const UNTAGGED_KEY = "__untagged__"
const UNTAGGED_LABEL = "Untagged"

export interface TagFacet {
	name: string
	count: number
}

export interface TagGroup<T> {
	/** Tag value, or {@link UNTAGGED_KEY}. */
	key: string
	label: string
	count: number
	items: T[]
}

/**
 * One facet per distinct tag with the number of items carrying it. Sorted by
 * count desc, then name, so the heaviest tags surface first in the filter.
 */
export function tagFacets<T>(items: readonly T[], getTags: (item: T) => readonly string[]): TagFacet[] {
	const counts = new Map<string, number>()
	for (const item of items) {
		for (const tag of getTags(item)) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1)
		}
	}
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/**
 * Keep an item when it carries any of the selected tags (OR semantics). An
 * empty selection is a no-op (returns the input array reference).
 */
export function filterByTags<T>(
	items: readonly T[],
	getTags: (item: T) => readonly string[],
	selected: readonly string[],
): readonly T[] {
	if (selected.length === 0) return items
	const wanted = new Set(selected)
	return items.filter((item) => getTags(item).some((tag) => wanted.has(tag)))
}

/**
 * Bucket items by tag for "Group by tag". An item appears under *every* tag it
 * carries (label-style), and items with no tags collapse into a single
 * {@link UNTAGGED_KEY} group rendered last. Tagged groups are sorted by name.
 */
export function groupByTag<T>(items: readonly T[], getTags: (item: T) => readonly string[]): TagGroup<T>[] {
	const tagged = new Map<string, T[]>()
	const untagged: T[] = []

	for (const item of items) {
		const tags = getTags(item)
		if (tags.length === 0) {
			untagged.push(item)
			continue
		}
		for (const tag of tags) {
			const bucket = tagged.get(tag)
			if (bucket) bucket.push(item)
			else tagged.set(tag, [item])
		}
	}

	const groups: TagGroup<T>[] = [...tagged.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, groupItems]) => ({ key, label: key, count: groupItems.length, items: groupItems }))

	if (untagged.length > 0) {
		groups.push({ key: UNTAGGED_KEY, label: UNTAGGED_LABEL, count: untagged.length, items: untagged })
	}

	return groups
}
