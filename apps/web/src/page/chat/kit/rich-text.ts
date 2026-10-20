import { type AnnotationSegment, parseAnnotations } from "@maple/domain/chat-annotations"
import { stripChatContext } from "@maple/domain/chat-preamble"
import type { UIMessage } from "./ui-message"

// Rich text: prose split at inline `<<maple:…>>`
// cards. Only the markdown segments need the (async) parser.

export type RichTextBody =
	| { readonly _tag: "Plain"; readonly text: string }
	| { readonly _tag: "Segments"; readonly segments: ReadonlyArray<AnnotationSegment> }

export const richTextSegments = (text: string): RichTextBody => {
	const segments = parseAnnotations(text)
	const only = segments[0]
	return segments.length === 1 && only !== undefined && only.type === "text"
		? { _tag: "Plain", text }
		: { _tag: "Segments", segments }
}

/** The markdown bodies one text renders. */
export const markdownBodies = (text: string): ReadonlyArray<string> => {
	const body = richTextSegments(text)
	return body._tag === "Plain"
		? [body.text]
		: body.segments.flatMap((segment) =>
				segment.type === "text" && segment.content.trim() !== "" ? [segment.content] : [],
			)
}

/** Every markdown body a transcript renders: prose (preamble stripped) and sub-agent answers. */
export const transcriptMarkdown = (messages: ReadonlyArray<UIMessage>): ReadonlyArray<string> =>
	messages.flatMap((message) =>
		message.parts.flatMap((part) => {
			if (part._tag === "text") {
				const text = stripChatContext(part.text)
				return text === "" ? [] : markdownBodies(text)
			}
			if (part._tag === "task")
				return [
					...(part.answer === undefined ? [] : [part.answer]),
					...part.messages.flatMap((child) =>
						child.parts.flatMap((leaf) => (leaf._tag === "text" && leaf.text !== "" ? [leaf.text] : [])),
					),
				]
			return []
		}),
	)
