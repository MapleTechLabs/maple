/**
 * Tag grouping for the alerts Rules tab, generic over the item type via a
 * `getTags` accessor.
 */

/** Stable key for the bucket holding items with no tags. */
export const UNTAGGED_KEY = "__untagged__"
const UNTAGGED_LABEL = "Untagged"

export interface TagGroup<T> {
	/** Tag value, or {@link UNTAGGED_KEY}. */
	key: string
	label: string
	count: number
	items: T[]
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
