/**
 * JSON-LD for docs pages: a TechArticle per page and the BreadcrumbList behind
 * the visible trail. Docs carry no dates, so none are emitted: a build-time date
 * would claim every page changed on every deploy.
 */

export interface DocsCrumb {
	name: string
	/** Site-relative path. Crumbs without one are labels only and stay out of the list. */
	path?: string
}

export interface DocsArticleInput {
	site: string
	slug: string
	title: string
	description: string
	image: string
	author?: { name: string; github: string }
	section?: string
}

// Page URLs end in a slash like the canonicals; file URLs (images) do not.
const absolute = (site: string, path: string) =>
	new URL(path.endsWith("/") || /\.\w+$/.test(path) ? path : `${path}/`, site).toString()

export const docsArticleLd = (input: DocsArticleInput) => {
	const url = absolute(input.site, `/docs/${input.slug}`)
	const publisher = {
		"@type": "Organization",
		name: "Maple",
		url: absolute(input.site, "/"),
		logo: { "@type": "ImageObject", url: absolute(input.site, "/logo192.png") },
	}
	return {
		"@context": "https://schema.org",
		"@type": "TechArticle",
		headline: input.title,
		description: input.description.replaceAll("`", ""),
		url,
		mainEntityOfPage: url,
		image: absolute(input.site, input.image),
		inLanguage: "en",
		...(input.section ? { articleSection: input.section } : undefined),
		author: input.author
			? { "@type": "Person", name: input.author.name, url: `https://github.com/${input.author.github}` }
			: publisher,
		publisher,
		isPartOf: { "@type": "WebSite", name: "Maple Docs", url: absolute(input.site, "/docs") },
	}
}

/** The trail as linked crumbs, ending with the page itself. */
export const docsBreadcrumbLd = (site: string, trail: DocsCrumb[], page: { name: string; slug: string }) => {
	const crumbs = [
		...trail.flatMap((crumb) => (crumb.path ? [{ name: crumb.name, path: crumb.path }] : [])),
		{ name: page.name, path: `/docs/${page.slug}` },
	]
	return {
		"@context": "https://schema.org",
		"@type": "BreadcrumbList",
		itemListElement: crumbs.map((crumb, index) => ({
			"@type": "ListItem",
			position: index + 1,
			name: crumb.name,
			item: absolute(site, crumb.path),
		})),
	}
}
