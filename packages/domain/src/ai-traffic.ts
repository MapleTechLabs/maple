// Catalog of AI products for the Web Analytics AI tab: which referrers and UTM
// sources mean "a person sent here by this assistant", and which crawler user
// agents mean "this assistant's fetcher read your page". Pure data, so the web
// bundle can import it; the SQL built from it lives in `tinybird/ai-crawler-columns.ts`.

/** Why a crawler fetched a page: model training, a search index, or a live user question. */
export type AiCrawlPurpose = "training" | "search" | "answers"

export const AI_CRAWL_PURPOSES: ReadonlyArray<AiCrawlPurpose> = ["training", "search", "answers"]

export interface AiProduct {
	/** Stable id. It is a query result value and a URL filter value. */
	readonly id: string
	readonly label: string
	/** Exact referrer hosts, compared after dropping a leading `www.`. Android app ids arrive as hosts. */
	readonly referrerHosts: ReadonlyArray<string>
	/** Exact `utm_source` values, compared lowercased. ChatGPT tags links this way. */
	readonly utmSources: ReadonlyArray<string>
	/** Set when the product fetches under a general search crawler we cannot tell apart. */
	readonly crawlsAs?: string
}

/** Products in display order. The first six always get a card, even at zero. */
export const AI_PRODUCTS: ReadonlyArray<AiProduct> = [
	{
		id: "chatgpt",
		label: "ChatGPT",
		referrerHosts: ["chatgpt.com", "chat.openai.com", "com.openai.chatgpt"],
		utmSources: ["chatgpt.com", "chatgpt", "chat.openai.com", "openai"],
	},
	{
		id: "claude",
		label: "Claude",
		referrerHosts: ["claude.ai", "com.anthropic.claude"],
		utmSources: ["claude.ai", "claude"],
	},
	{
		id: "gemini",
		label: "Google Gemini",
		referrerHosts: ["gemini.google.com", "bard.google.com"],
		utmSources: ["gemini.google.com", "gemini"],
		crawlsAs: "Googlebot",
	},
	{
		id: "perplexity",
		label: "Perplexity",
		referrerHosts: ["perplexity.ai", "ai.perplexity.app.android"],
		utmSources: ["perplexity.ai", "perplexity"],
	},
	{
		id: "copilot",
		label: "Microsoft Copilot",
		referrerHosts: ["copilot.microsoft.com", "copilot.cloud.microsoft", "m365.cloud.microsoft"],
		utmSources: ["copilot.microsoft.com", "copilot.com", "copilot"],
		crawlsAs: "Bingbot",
	},
	{
		id: "meta",
		label: "Meta AI",
		referrerHosts: ["meta.ai"],
		utmSources: ["meta.ai"],
	},
	{
		id: "doubao",
		label: "Doubao",
		referrerHosts: ["doubao.com"],
		utmSources: ["doubao.com", "doubao"],
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		referrerHosts: ["chat.deepseek.com", "deepseek.com"],
		utmSources: ["deepseek.com", "deepseek"],
	},
	{
		id: "grok",
		label: "Grok",
		referrerHosts: ["grok.com"],
		utmSources: ["grok.com", "grok"],
	},
	{
		id: "mistral",
		label: "Le Chat",
		referrerHosts: ["chat.mistral.ai"],
		utmSources: ["chat.mistral.ai", "mistral"],
	},
	{
		id: "kimi",
		label: "Kimi",
		referrerHosts: ["kimi.com", "kimi.moonshot.cn"],
		utmSources: ["kimi.com", "kimi"],
	},
	// Crawler-only: they fetch pages but send no visitors.
	{ id: "commoncrawl", label: "Common Crawl", referrerHosts: [], utmSources: [] },
	{ id: "amazon", label: "Amazon", referrerHosts: [], utmSources: [] },
	{ id: "duckduckgo", label: "DuckDuckGo", referrerHosts: [], utmSources: [] },
	{ id: "cohere", label: "Cohere", referrerHosts: [], utmSources: [] },
]

/** How many products the AI tab gives a card regardless of traffic. */
export const AI_PRODUCT_CARD_COUNT = 6

export interface AiCrawler {
	/** Case-insensitive substring of the user agent. No token may contain another. */
	readonly token: string
	/** Display name, and the value stored in `ai_crawler_requests.Crawler`. */
	readonly name: string
	readonly product: string
	readonly purpose: AiCrawlPurpose
}

/**
 * Published AI fetchers. Adding one only affects rows materialized after the
 * migration that ships it, so the list is limited to documented user agents.
 */
export const AI_CRAWLERS: ReadonlyArray<AiCrawler> = [
	{ token: "GPTBot", name: "GPTBot", product: "chatgpt", purpose: "training" },
	{ token: "OAI-SearchBot", name: "OAI-SearchBot", product: "chatgpt", purpose: "search" },
	{ token: "ChatGPT-User", name: "ChatGPT-User", product: "chatgpt", purpose: "answers" },
	{ token: "ClaudeBot", name: "ClaudeBot", product: "claude", purpose: "training" },
	{ token: "anthropic-ai", name: "anthropic-ai", product: "claude", purpose: "training" },
	{ token: "Claude-SearchBot", name: "Claude-SearchBot", product: "claude", purpose: "search" },
	{ token: "Claude-User", name: "Claude-User", product: "claude", purpose: "answers" },
	{ token: "PerplexityBot", name: "PerplexityBot", product: "perplexity", purpose: "search" },
	{ token: "Perplexity-User", name: "Perplexity-User", product: "perplexity", purpose: "answers" },
	{ token: "meta-externalagent", name: "Meta-ExternalAgent", product: "meta", purpose: "training" },
	{ token: "meta-webindexer", name: "Meta-WebIndexer", product: "meta", purpose: "search" },
	{ token: "meta-externalfetcher", name: "Meta-ExternalFetcher", product: "meta", purpose: "answers" },
	{ token: "Bytespider", name: "Bytespider", product: "doubao", purpose: "training" },
	{ token: "MistralAI-User", name: "MistralAI-User", product: "mistral", purpose: "answers" },
	{ token: "CCBot", name: "CCBot", product: "commoncrawl", purpose: "training" },
	{ token: "Amazonbot", name: "Amazonbot", product: "amazon", purpose: "training" },
	{ token: "DuckAssistBot", name: "DuckAssistBot", product: "duckduckgo", purpose: "answers" },
	{
		token: "cohere-training-data-crawler",
		name: "cohere-training-data-crawler",
		product: "cohere",
		purpose: "training",
	},
	{ token: "cohere-ai", name: "cohere-ai", product: "cohere", purpose: "answers" },
]

/** What kind of document a crawler fetched, from the request path. */
export type AiContentFormat = "markdown" | "llms" | "html" | "other"

export const AI_CONTENT_FORMATS: ReadonlyArray<AiContentFormat> = ["markdown", "llms", "html", "other"]

export const isAiContentFormat = (value: string): value is AiContentFormat =>
	(AI_CONTENT_FORMATS as ReadonlyArray<string>).includes(value)

const productsById = new Map(AI_PRODUCTS.map((product) => [product.id, product]))

export const aiProductById = (id: string): AiProduct | undefined => productsById.get(id)
