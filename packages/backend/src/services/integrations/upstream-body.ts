const MAX_SNIPPET = 160

// Any body opening with a tag, comment, doctype or processing instruction is markup.
const looksLikeHtml = (body: string) => /^<[a-zA-Z!/?]/.test(body.trimStart())

const collapse = (text: string) => text.replace(/\s+/g, " ").trim()

// Visible text only: script/style bodies go first so their code never reaches a message.
const stripTags = (markup: string) =>
	collapse(
		markup
			.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<[^>]*>?/g, " "),
	)

const truncate = (text: string) => (text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}...` : text)

/**
 * A short, log-safe summary of an upstream error body. HTML (an edge block or challenge page) is
 * reduced to its `<title>`, and the `cf-ray` id is kept so the edge event can be looked up.
 */
export const summarizeUpstreamBody = (body: string, headers: Readonly<Record<string, string>>): string => {
	const ray = headers["cf-ray"]
	const rayPart = ray ? ` (cf-ray ${ray})` : ""
	if (!looksLikeHtml(body)) {
		const text = truncate(collapse(body))
		return `${text === "" ? "empty body" : text}${rayPart}`
	}
	const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "")
	if (title !== "") return `HTML response "${truncate(title)}"${rayPart}`
	const text = stripTags(body)
	return `${text === "" ? "HTML response" : `HTML response: ${truncate(text)}`}${rayPart}`
}

/**
 * Statuses where the ingest edge or gateway refuses the org's key outright (billing, revoked or
 * edge-blocked key). Retrying every tick cannot succeed, so pollers back off instead.
 */
export const isIngestRefusal = (status: number) => status === 401 || status === 402 || status === 403
