import { Array as Arr, Option } from "effect"

/**
 * Blog authors, by the `author` name a post's frontmatter carries. Each gets a page at
 * `/blog/authors/<slug>` and a schema.org `Person` on every post they wrote.
 */
export interface Author {
	slug: string
	name: string
	role: string
	bio: string
	/** Square photo under `public/`, at least 400px. Without one the Maple mark stands in. */
	avatar?: string
	/** Profiles that are the same person, for schema.org `sameAs`. */
	sameAs: ReadonlyArray<{ label: string; url: string }>
}

export const AUTHORS: ReadonlyArray<Author> = [
	{
		slug: "david-granzin",
		name: "David Granzin",
		role: "Founder, Maple",
		bio: "David is the founder of Maple. He writes about tracing, product analytics and how Maple is built.",
		avatar: "/blog/authors/david-granzin.webp",
		sameAs: [
			{ label: "X", url: "https://x.com/makisuo" },
			{ label: "GitHub", url: "https://github.com/Makisuo" },
		],
	},
]

export const authorByName = (name: string): Option.Option<Author> =>
	Arr.findFirst(AUTHORS, (author) => author.name === name)

export const authorBySlug = (slug: string): Option.Option<Author> =>
	Arr.findFirst(AUTHORS, (author) => author.slug === slug)

export const authorHref = (author: Author): string => `/blog/authors/${author.slug}`

/** schema.org `Person`, as the blog's JSON-LD writes it. */
export interface PersonLd {
	"@type": "Person"
	name: string
	jobTitle: string
	url: string
	image?: string
	sameAs: ReadonlyArray<string>
	worksFor: { "@type": "Organization"; name: string; url: string }
}

/** The schema.org `Person` for an author, with absolute URLs on `site`. */
export const authorPerson = (author: Author, site: URL | undefined): PersonLd => {
	const absolute = (path: string) => (site === undefined ? path : new URL(path, site).toString())
	const person: PersonLd = {
		"@type": "Person",
		name: author.name,
		jobTitle: author.role,
		url: absolute(authorHref(author)),
		sameAs: Arr.map(author.sameAs, (link) => link.url),
		worksFor: { "@type": "Organization", name: "Maple", url: "https://maple.dev" },
	}
	if (author.avatar !== undefined) person.image = absolute(author.avatar)
	return person
}
