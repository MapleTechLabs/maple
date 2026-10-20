import type { IntegrationsSearch } from "../../route/search"

// The chat connector's OAuth return (`?chat=` / `?chat_identity=`): one toast, then the params go.

type Search = typeof IntegrationsSearch.Type

const CHAT_ERROR_COPY = {
	workspace: {
		generic: "Couldn't link the chat workspace. Try again.",
		reasons: new Map<string, string>([
			["state", "The install link expired. Start the install again."],
			["conflict", "That workspace is already linked to a different Maple organization."],
			["unconfigured", "This chat connector isn't configured in Maple. Contact support."],
			["unknown", "Unknown chat connector."],
		]),
	},
	identity: {
		generic: "Couldn't link your chat account. Try again.",
		reasons: new Map<string, string>([
			["state", "The link expired. Start the account link again."],
			["unconfigured", "This chat connector isn't configured in Maple. Contact support."],
			["unknown", "Unknown chat connector."],
		]),
	},
} as const

const MAX_UNTRUSTED_LABEL = 64

const clampLabel = (value: string): string =>
	value.length > MAX_UNTRUSTED_LABEL ? `${value.slice(0, MAX_UNTRUSTED_LABEL - 1)}…` : value

export interface ChatCallback {
	readonly title: string
	readonly type: "success" | "error"
	/** The search with the return params stripped (`{ integration }` or `{}`). */
	readonly next: Search
}

export const chatCallbackOf = (search: Search): ChatCallback | null => {
	const kind =
		search.chat === "connected" || search.chat === "error"
			? "workspace"
			: search.chat_identity === "linked" || search.chat_identity === "error"
				? "identity"
				: null
	if (kind === null) return null
	const ok = search.chat === "connected" || search.chat_identity === "linked"
	const rawName = search.chat_workspace ?? search.chat_identity_name
	const name = rawName !== undefined && rawName !== "" ? clampLabel(rawName) : ""
	const connected =
		kind === "workspace"
			? name.length > 0
				? `Connected ${name}`
				: "Chat workspace connected"
			: name.length > 0
				? `Linked as ${name}`
				: "Chat account linked"
	const copy = CHAT_ERROR_COPY[kind]
	const reason = search.chat_reason
	const failed =
		(reason !== undefined && reason !== "" ? copy.reasons.get(reason.trim()) : undefined) ?? copy.generic
	return {
		title: ok ? connected : failed,
		type: ok ? "success" : "error",
		next:
			search.integration !== undefined && search.integration !== ""
				? { integration: search.integration }
				: {},
	}
}
