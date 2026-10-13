const MAX_SNIPPET = 160

const looksLikeHtml = (body: string) => /^\s*(<!doctype html|<html|<!--|<head|<body)/i.test(body)

const collapse = (text: string) => text.replace(/\s+/g, " ").trim()

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
	const title = collapse((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "").replace(/<[^>]*>/g, ""))
	return `${title === "" ? "HTML response" : `HTML response "${truncate(title)}"`}${rayPart}`
}

/**
 * Statuses where the ingest edge or gateway refuses the org's key outright (billing, revoked or
 * edge-blocked key). Retrying every tick cannot succeed, so pollers back off instead.
 */
export const isIngestRefusal = (status: number) => status === 401 || status === 402 || status === 403
