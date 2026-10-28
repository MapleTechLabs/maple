import { StatusPageSlug } from "@maple/domain/status-page"
import { Schema } from "effect"

// The page address: suggested from the name until typed, checked as the API checks it.

const SLUG_MAX = 48

/** `Acme Status!` as `acme-status`: lowercase letters and digits, single inner hyphens. */
export const slugFromName = (name: string): string =>
	name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, SLUG_MAX)
		.replace(/-+$/u, "")

const isSlug = Schema.is(StatusPageSlug)

/** Why a slug would be refused, or `null` when it is fine. */
export const slugIssue = (slug: string): string | null =>
	slug === ""
		? "Add an address."
		: isSlug(slug)
			? null
			: "Use 3 to 48 lowercase letters, digits or inner hyphens."
