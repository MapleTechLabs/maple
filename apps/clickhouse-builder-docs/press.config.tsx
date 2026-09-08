import { flexsearchPlugin } from "fumapress/plugins/flexsearch"
import { sitemapPlugin } from "fumapress/plugins/sitemap"
import { robotsPlugin } from "fumapress/plugins/robots"
import { llmsPlugin } from "fumapress/plugins/llms.txt"
import { defineConfig } from "fumapress"
import { fumadocsMdx } from "fumapress/adapters/mdx"
import { metaSchema, pageSchema } from "fumapress/adapters/mdx/schema"
import { defineDocs } from "fumadocs-mdx/macro"

const docs = defineDocs({
	dir: "content",
	docs: {
		async: true,
		schema: pageSchema,
		lastModified: false,
		postprocess: {
			includeProcessedMarkdown: true,
		},
	},
	meta: {
		schema: metaSchema,
	},
})

export default defineConfig({
	mode: "static",
	preset: false,
	defaultLayoutProps: {
		links: [
			{
				text: "GitHub",
				url: "https://github.com/MapleTechLabs/maple/tree/main/lib/clickhouse-builder",
			},
		],
	},
	content: docs.toFumadocsSource(),
	site: {
		name: "Effect ClickHouse",
		baseUrl: "https://effect-clickhouse.maple.dev",
	},
	meta: {
		root() {
			return (
				<>
					<link rel="preconnect" href="https://fonts.googleapis.com" />
					<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
					<link
						href="https://fonts.googleapis.com/css2?family=Geist:ital,wght@0,100..900;1,100..900&family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap"
						rel="stylesheet"
					/>
				</>
			)
		},
	},
})
	.adapters(fumadocsMdx())
	.plugins(flexsearchPlugin(), sitemapPlugin(), robotsPlugin(), llmsPlugin())
