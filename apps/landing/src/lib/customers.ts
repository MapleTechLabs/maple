import { getCollection, getEntry, type CollectionEntry } from "astro:content"

export type CustomerStory = CollectionEntry<"customers">

/** Published stories, newest first. Drafts are excluded in production builds. */
export async function getSortedStories(): Promise<CustomerStory[]> {
	const stories = await getCollection("customers", ({ data }) => !data.draft || import.meta.env.DEV)
	return stories.sort((a, b) => b.data.date.getTime() - a.data.date.getTime())
}

/** The story's `logos` entry: the customer's name, site and brand mark id. */
export async function getStoryCustomer(story: CustomerStory) {
	return getEntry(story.data.customer)
}
