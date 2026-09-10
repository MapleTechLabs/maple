"use client"

import type { ComponentProps } from "react"

import { cn } from "@maple/ui/lib/utils"
import { cjk } from "@streamdown/cjk"
import { code } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
import { memo } from "react"
import { Streamdown, type PluginConfig } from "streamdown"

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
 * Streamdown wraps every table in a padded, bordered card that itself contains a
 * bordered scroll box, and pads each cell to `px-4 py-2` at `text-sm`. That is a
 * document-page table dropped into a chat column: two nested borders around a
 * four-row comparison, and a third of the reply's height spent on padding.
 *
 * Flattened to the outer border only, with the transcript's own density. The
 * table's copy/download/fullscreen toolbar goes with it (see `controls` below) —
 * the assistant turn already has a copy action, and the row cost more height than
 * the data it sat above.
 */
const COMPACT_TABLES = [
	"[&_[data-streamdown=table-wrapper]]:my-2",
	"[&_[data-streamdown=table-wrapper]]:gap-0",
	"[&_[data-streamdown=table-wrapper]]:rounded-lg",
	"[&_[data-streamdown=table-wrapper]]:border-border",
	"[&_[data-streamdown=table-wrapper]]:bg-transparent",
	"[&_[data-streamdown=table-wrapper]]:p-0",
	"[&_[data-streamdown=table-wrapper]>div]:rounded-none",
	"[&_[data-streamdown=table-wrapper]>div]:border-0",
	"[&_[data-streamdown=table-wrapper]>div]:bg-transparent",
	"[&_[data-streamdown=table-header]]:bg-muted/60",
	"[&_[data-streamdown=table-header-cell]]:px-2.5",
	"[&_[data-streamdown=table-header-cell]]:py-1.5",
	"[&_[data-streamdown=table-header-cell]]:text-xs",
	"[&_[data-streamdown=table-cell]]:px-2.5",
	"[&_[data-streamdown=table-cell]]:py-1",
	"[&_[data-streamdown=table-cell]]:text-xs",
	"[&_[data-streamdown=table-cell]]:tabular-nums",
].join(" ")

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
				COMPACT_TABLES,
				className,
			)}
			controls={CONTROLS}
			plugins={lightweight ? lightweightPlugins : streamdownPlugins}
			{...props}
		/>
	),
	(prevProps, nextProps) => prevProps.children === nextProps.children,
)

MessageResponse.displayName = "MessageResponse"
