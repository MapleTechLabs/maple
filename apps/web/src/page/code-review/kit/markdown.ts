import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// Static lightweight markdown for the review report's text: Streamdown's root classes, one `<p>`
// per paragraph.
// TODO(markdown): lists, code, emphasis and links inside a report render as plain paragraphs;
// Streamdown's element markup is not drawn yet.

const MESSAGE_RESPONSE_CLASSES = cn(
	"size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
	"[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm",
	"[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold",
	"[&_h1]:mt-4 [&_h2]:mt-4 [&_h3]:mt-4 [&_h4]:mt-4 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_h4]:mb-1",
)

/** Paragraphs are separated by a blank line; single newlines fold into the paragraph. */
const paragraphs = (text: string): ReadonlyArray<string> =>
	text
		.split(/\n\s*\n/u)
		.map((paragraph) => paragraph.replace(/\s*\n\s*/gu, " ").trim())
		.filter((paragraph) => paragraph.length > 0)

export const messageResponse = <M>(h: HtmlBuilder<M>, text: string, className?: string): Html =>
	h.div(
		[h.Class(cn("space-y-4 whitespace-normal", MESSAGE_RESPONSE_CLASSES, className))],
		paragraphs(text).map((paragraph) => h.p([], [paragraph])),
	)
