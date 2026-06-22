/**
 * Local message/part types for the chat UI. `UIMessage`/`UIMessagePart` come
 * from `@flue/react` (which mirrors the AI SDK v5 data shape without depending
 * on the `ai` package). `ChatStatus`/`FileUIPart`/`SourceDocumentUIPart` were
 * previously imported from `ai`; they're declared here so the UI components
 * don't pull in the (now removed) Vercel AI SDK.
 */
export type { UIMessage, UIMessagePart } from "@flue/react"

/** Composer status. Flue's `idle`/`connecting` map to `ready` for the submit button. */
export type ChatStatus = "submitted" | "streaming" | "ready" | "error"

export interface FileUIPart {
	type: "file"
	mediaType: string
	filename?: string
	url: string
}

export interface SourceDocumentUIPart {
	type: "source-document"
	sourceId: string
	mediaType: string
	title: string
	filename?: string
	providerMetadata?: Record<string, unknown>
}
