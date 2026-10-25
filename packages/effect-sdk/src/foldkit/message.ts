import { Predicate } from "effect"

const MAX_DEPTH = 4

/**
 * `GotChat > SubmittedComposer` for a Submodel Message wrapped by its parent.
 * Only `_tag`s: a Message's fields can hold anything the user typed.
 */
export const messageTag = (message: unknown): string => {
	const tags: Array<string> = []
	let current = message
	while (
		tags.length < MAX_DEPTH &&
		Predicate.hasProperty(current, "_tag") &&
		typeof current._tag === "string"
	) {
		tags.push(current._tag)
		current = Predicate.hasProperty(current, "message") ? current.message : undefined
	}
	return tags.length === 0 ? "unknown" : tags.join(" > ")
}

/** The last `size` Message tags, oldest first, for crash reports. */
export const makeRecentMessages = (size: number) => {
	const items: Array<string> = []
	return {
		push: (tag: string): void => {
			items.push(tag)
			if (items.length > size) items.shift()
		},
		read: (): ReadonlyArray<string> => items.slice(),
	}
}
