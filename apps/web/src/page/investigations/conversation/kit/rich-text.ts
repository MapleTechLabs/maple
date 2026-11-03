import { type AnnotationSegment, parseAnnotations } from "@maple/domain/chat-annotations"
import { stripChatContext } from "@maple/domain/chat-preamble"
import type { UIMessage } from "./ui-message"
import { Array as Arr, String as Str } from "effect"

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
		: Arr.flatMap(body.segments, (segment) =>
				segment.type === "text" && Str.trim(segment.content) !== "" ? [segment.content] : [],
			)
}

/** Every markdown body a transcript renders: prose (preamble stripped) and sub-agent answers. */
export const transcriptMarkdown = (messages: ReadonlyArray<UIMessage>): ReadonlyArray<string> =>
	Arr.flatMap(messages, (message) =>
		Arr.flatMap(message.parts, (part) => {
			if (part._tag === "text") {
				const text = stripChatContext(part.text)
				return text === "" ? [] : markdownBodies(text)
			}
			if (part._tag === "task")
				return [
					...(part.answer === undefined ? [] : [part.answer]),
					...Arr.flatMap(part.messages, (child) =>
						Arr.flatMap(child.parts, (leaf) =>
							leaf._tag === "text" && leaf.text !== "" ? [leaf.text] : [],
						),
					),
				]
			return []
		}),
	)
