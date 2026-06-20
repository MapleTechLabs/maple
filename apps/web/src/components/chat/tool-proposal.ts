/**
 * Flue uses propose-then-apply for mutating tools: the agent calls the tool, but
 * its `execute` returns this marker (as the tool's output) WITHOUT mutating. The
 * web client renders an approval card from it and applies the real change via
 * `POST /api/chat/apply` on approve. Mirrors `apps/chat-flue/src/lib/approval.ts`.
 */
export interface ToolProposal {
	status: "proposed"
	tool: string
	input: unknown
}

/** Parse a `dynamic-tool` output into a {@link ToolProposal}, or `null`. */
export const parseToolProposal = (output: unknown): ToolProposal | null => {
	let value: unknown = output
	if (typeof output === "string") {
		try {
			value = JSON.parse(output)
		} catch {
			return null
		}
	}
	if (!value || typeof value !== "object") return null
	const v = value as Record<string, unknown>
	return v.status === "proposed" && typeof v.tool === "string"
		? { status: "proposed", tool: v.tool, input: v.input }
		: null
}
