import { defineCollection, reference, z } from "astro:content"
import { glob } from "astro/loaders"
import { LANGUAGE_IDS } from "./lib/docs-languages"

const roadmap = defineCollection({
	loader: glob({ pattern: "**/*.md", base: "./src/content/roadmap" }),
	schema: z.object({
		title: z.string(),
		status: z.enum(["shipped", "in-progress", "planned", "exploring"]),
		category: z.enum(["traces", "logs", "metrics", "alerting", "integrations", "platform", "ai"]),
		quarter: z.string(),
		description: z.string(),
		order: z.number().default(0),
		shipped_date: z.string().optional(),
	}),
})

const docs = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/docs" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		group: z.string(),
		order: z.number().default(0),
		draft: z.boolean().default(false),
		// Short label for the sidebar when the title is too long for one row
		// ("Node.js" for "Node.js Instrumentation").
		navLabel: z.string().optional(),
		sdk: z.enum(LANGUAGE_IDS).optional(),
	}),
})

const blog = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/blog" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		date: z.coerce.date(),
		author: z.string().default("Maple Team"),
		// Byline subtitle (role/title). Omitted for the "Maple Team" default.
		authorRole: z.string().optional(),
		category: z.enum(["engineering", "product", "guides", "company"]).optional(),
		// Optional real cover screenshot served from /public/blog; falls back to a
		// generated on-brand motif when omitted.
		cover: z.string().optional(),
		coverAlt: z.string().optional(),
		featured: z.boolean().default(false),
		draft: z.boolean().default(false),
	}),
})

// One entry per monthly release — the filename is the permalink (`2026-07.md`
// → /changelog/2026-07), so it sorts chronologically on disk too. `highlights`
// feeds the index panel; the body is the full release note.
const changelog = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/changelog" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		date: z.coerce.date(), // month close — sorts the ledger, drives <time>
		highlights: z.array(z.string()).default([]),
		// Release cover served from /public/changelog. Doubles as the per-release
		// OG card; without it the page falls back to the generic /og-image.png.
		cover: z.string().optional(),
		coverAlt: z.string().optional(),
		// Drives the BREAKING marker only. The prose stays in the body so there
		// is one source of truth for what actually broke.
		breaking: z.boolean().default(false),
		draft: z.boolean().default(false),
	}),
})

// Customer logos rendered in the homepage "trusted by" marquee. Frontmatter-only
// entries (no body) — one file per company. The entry id (filename) maps to a
// brand logo component in the LOGOS registry inside CustomerLogos.astro.
const logos = defineCollection({
	loader: glob({ pattern: "**/*.md", base: "./src/content/logos" }),
	schema: z.object({
		name: z.string(),
		href: z.string().url().optional(), // present → linked, absent → static
		order: z.number().default(0),
	}),
})

// Customer success stories, served under /customers. The customer's name, site
// and brand mark come from its `logos` entry, so a story can't name a company
// the logo band doesn't know.
const customers = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/customers" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		date: z.coerce.date(),
		customer: reference("logos"),
		author: z.string().default("Maple Team"),
		authorRole: z.string().optional(),
		// Headline numbers for the stat strip on the card and the story page.
		highlights: z.array(z.object({ value: z.string(), label: z.string() })).max(4).default([]),
		cover: z.string().optional(),
		coverAlt: z.string().optional(),
		featured: z.boolean().default(false),
		draft: z.boolean().default(false),
	}),
})

export const collections = { roadmap, docs, blog, changelog, logos, customers }
