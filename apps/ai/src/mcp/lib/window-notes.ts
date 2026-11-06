import { Context } from "effect"
import type { ToolDoc } from "./tool-doc"

/**
 * What resolving a tool's time window wants the model to see: the server clock and any
 * adjustment (clamped end, capped start, short window). Collected per call by the registry,
 * so every time-windowed tool reports them without threading them through its output.
 */
export class WindowNotes {
	now: string | undefined = undefined
	readonly notices: Array<string> = []

	record(now: string, notices: ReadonlyArray<string>): void {
		this.now = now
		for (const notice of notices) if (!this.notices.includes(notice)) this.notices.push(notice)
	}

	/** The doc with "Now (UTC)" in its scope line and the window notices added. */
	decorate(doc: ToolDoc): ToolDoc {
		if (this.now === undefined) return doc
		return {
			...doc,
			scope: [...(doc.scope ?? []), ["Now (UTC)", this.now]],
			...(this.notices.length === 0
				? undefined
				: { notices: [...this.notices, ...(doc.notices ?? [])] }),
		}
	}
}

export class CurrentWindowNotes extends Context.Reference<WindowNotes | undefined>(
	"@maple/ai/mcp/CurrentWindowNotes",
	{ defaultValue: () => undefined },
) {}
