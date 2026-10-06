// Single source of truth for docs navigation ordering. The sidebar
// (DocsSidebar), the index page, prev/next and search all read from here so
// section and group order never drift apart. Pure data — client islands import it.

/**
 * The sidebar is split into sections so a reader sees one section's tree at a
 * time: product surfaces, the "get data in" guides, the local binary, and the
 * machine-facing references. Groups are listed in sidebar order; `icon` is a
 * DocsCategoryIcon id, shared with the header strip.
 */
export const SECTIONS = [
	{
		id: "platform",
		icon: "Dashboards",
		label: "Platform",
		blurb: "Concepts and every product surface.",
		groups: [
			"Getting Started",
			"Concepts",
			"Explore",
			"Errors",
			"Session Replay",
			"Product Events",
			"Agent Sessions",
			"Dashboards",
			"Alerting",
			"Integrations",
		],
	},
	{
		id: "instrumentation",
		icon: "Instrumentation",
		label: "Instrumentation",
		blurb: "Languages, frameworks, AI agents, hosts and clusters.",
		groups: ["Instrumentation", "AI Agents", "Infrastructure"],
	},
	{
		id: "local",
		icon: "Local Mode",
		label: "Local Mode",
		blurb: "The whole product as one binary.",
		groups: ["Local Mode"],
	},
	{
		id: "reference",
		icon: "Reference",
		label: "Reference",
		blurb: "APIs, CLI, ingest, SQL, webhooks and limits.",
		groups: ["Reference"],
	},
] as const

export type DocSection = (typeof SECTIONS)[number]
export type DocGroup = DocSection["groups"][number]

/** Doc groups in sidebar order (sections in order, groups within each). */
export const GROUP_ORDER: readonly DocGroup[] = SECTIONS.flatMap((section) => section.groups)

export const isDocGroup = (group: string): group is DocGroup => GROUP_ORDER.some((known) => known === group)

export const groupRank = (group: string): number => {
	const i = GROUP_ORDER.findIndex((known) => known === group)
	return i === -1 ? GROUP_ORDER.length : i
}

/** The section a group belongs to; unknown groups fall into the first one. */
export const sectionForGroup = (group: string): DocSection =>
	SECTIONS.find((section) => section.groups.some((known) => known === group)) ?? SECTIONS[0]

/** Slug of the instrumentation overview — the "SDKs" entry point everywhere. */
export const INSTRUMENTATION_SLUG = "instrumentation"
