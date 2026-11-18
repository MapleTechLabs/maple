import { StatusPageSlug } from "@maple/domain/status-page"
import { Schema } from "effect"

// The page address: suggested from the name until typed (`slugFromName`), checked as the API checks it.

/** The API's code for an address another page already has. */
export const SLUG_TAKEN = "status_page_slug_taken"

/** The field's message for it. */
export const SLUG_TAKEN_MESSAGE = "That address is taken. Pick another."

const isSlug = Schema.is(StatusPageSlug)

/** Why a slug would be refused, or `null` when it is fine. */
export const slugIssue = (slug: string): string | null =>
	slug === ""
		? "Add an address."
		: isSlug(slug)
			? null
			: "Use 3 to 48 lowercase letters, digits or inner hyphens."
