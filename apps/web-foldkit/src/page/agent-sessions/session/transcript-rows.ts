import { assembleTranscript, prepareTranscript, spanModel, type TranscriptRow } from "@maple/agent-sessions"
import { previewOf } from "./clamped-text"
import type { SessionData } from "./derive"
import type { Model } from "./model"
import { disclosed, messageBody } from "./payload-view"

// The transcript's rows and the markdown bodies they show, shared by the view and the parse it asks for.

const RENDER_LIMIT_CHARS = 200_000

/** The rows, in reading order, for the toolbar's filter and the reader's collapses. */
export const transcriptRows = (model: Model, data: SessionData): ReadonlyArray<TranscriptRow> =>
	assembleTranscript(
		prepareTranscript({
			turns: data.turns,
			toolResults: data.toolResults,
			query: model.query,
			showThinking: model.options.showThinking,
		}),
		{
			collapsedTurns: new Set(model.collapsedTurns),
			hasMore: data.progress !== undefined && !data.progress.agentSpansComplete,
		},
	)

/** Assistant rows that continue the previous speaker: same depth, same model, no failure between. */
export const continuedKeys = (rows: ReadonlyArray<TranscriptRow>): ReadonlySet<string> => {
	const keys = new Set<string>()
	rows.reduce<Readonly<{ depth: number; model: string | undefined }> | undefined>((speaker, row) => {
		if (row.kind === "assistant") {
			const model = spanModel(row.span)
			if (speaker !== undefined && speaker.depth === row.depth && speaker.model === model)
				keys.add(row.key)
			return row.failed || model === undefined ? undefined : { depth: row.depth, model }
		}
		return row.kind === "tool" || row.kind === "thinking" || row.kind === "structure"
			? speaker
			: undefined
	}, undefined)
	return keys
}

/** FNV-1a over the text: the markdown cache's key, short whatever the body's size. */
export const textHash = (text: string): string => {
	const hash = Array.from(text).reduce(
		(acc, char) => Math.imul(acc ^ (char.codePointAt(0) ?? 0), 16_777_619) >>> 0,
		2_166_136_261,
	)
	return `${hash.toString(36)}:${text.length}`
}

/** A message body as the transcript shows it: the markdown text it lays out, if it lays any out. */
export const shownMarkdown = (model: Model, key: string, text: string): ReadonlyArray<string> => {
	if (disclosed(model.openRows, `${key}:raw`, false) || messageBody(text).rendered !== "md") return []
	const shown = disclosed(model.openRows, `${key}:text`, false) ? text : previewOf(text)
	return shown.length > RENDER_LIMIT_CHARS ? [] : [shown]
}

/** Every markdown text the transcript has on the page. */
export const markdownTexts = (model: Model, rows: ReadonlyArray<TranscriptRow>): ReadonlyArray<string> =>
	rows.flatMap((row) => {
		switch (row.kind) {
			case "user":
			case "prompt":
				return shownMarkdown(model, row.key, row.text)
			case "assistant":
				return row.text === undefined ? [] : shownMarkdown(model, row.key, row.text)
			case "system":
				return disclosed(model.openRows, row.key, false)
					? shownMarkdown(model, row.key, row.text)
					: []
			default:
				return []
		}
	})
