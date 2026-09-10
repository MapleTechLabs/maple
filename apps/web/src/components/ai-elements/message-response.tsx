"use client"

import type { ComponentProps } from "react"

import { cn } from "@maple/ui/lib/utils"
import { cjk } from "@streamdown/cjk"
import { code } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
import { memo } from "react"
import { Streamdown, type Components, type PluginConfig } from "streamdown"
import {
	MarkdownTable,
	MarkdownTableBody,
	MarkdownTableCell,
	MarkdownTableHead,
	MarkdownTableHeader,
	MarkdownTableRow,
} from "./markdown-table"

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
	/**
	 * Markdown layout only — no Shiki, KaTeX or Mermaid. For a body that is
	 * mounted over and over rather than once: a virtualized transcript mounts a
	 * reply again every time it scrolls back into view, and tokenizing its code
	 * fences each time was most of the work in a scroll frame. Code still
	 * renders, as a plain block.
	 */
	lightweight?: boolean
}

const streamdownPlugins = { cjk, code, math, mermaid } as PluginConfig
const lightweightPlugins = { cjk } as PluginConfig

/**
 * Tables are ours, not Streamdown's. Its own table is a document-page table
 * dropped into a chat column — two nested borders around a four-row comparison,
 * `px-4 py-2` cells at `text-sm`, and a copy/download toolbar above data the
 * turn's own copy action already covers. Overriding the components rather than
 * their classes gets the product's `Table` primitive, and gives the cells
 * somewhere to recognize a trace id or a duration. See `markdown-table.tsx`.
 */
const COMPONENTS = {
	table: MarkdownTable,
	tbody: MarkdownTableBody,
	td: MarkdownTableCell,
	th: MarkdownTableHead,
	thead: MarkdownTableHeader,
	tr: MarkdownTableRow,
} satisfies Components

/** Code and mermaid keep their toolbars; only the table's is dropped. */
const CONTROLS = { table: false } as const

/**
 * Markdown renderer for assistant text. Memoized on `children` identity so a
 * streaming token only re-renders the message it lands in — the Shiki, KaTeX,
 * and Mermaid plugins are expensive enough that re-parsing the whole transcript
 * per token is visible as jank.
 */
export const MessageResponse = memo(
	({ className, lightweight = false, ...props }: MessageResponseProps) => (
		<Streamdown
			className={cn(
				"size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
				// Streamdown sizes headings for a document page. In a 420px panel an `##`
				// lands two thirds the width of the column, so every level renders at body
				// scale and separates by weight and spacing instead.
				"[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm",
				"[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold",
				"[&_h1]:mt-4 [&_h2]:mt-4 [&_h3]:mt-4 [&_h4]:mt-4 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_h4]:mb-1",
				className,
			)}
			components={COMPONENTS}
			controls={CONTROLS}
			plugins={lightweight ? lightweightPlugins : streamdownPlugins}
			{...props}
		/>
	),
	(prevProps, nextProps) => prevProps.children === nextProps.children,
)

MessageResponse.displayName = "MessageResponse"
