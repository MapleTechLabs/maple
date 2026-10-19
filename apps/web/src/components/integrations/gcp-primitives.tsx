import { Fragment } from "react"
import type React from "react"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { cn } from "@maple/ui/lib/utils"

import { ExternalLinkIcon } from "@/components/icons"

/** The page's one link style, the other integrations' (Railway's token link). */
export const GCP_LINK = "underline underline-offset-2 hover:no-underline"
/** Small print: one size, one colour, short lines. */
export const GCP_SMALL = "text-xs/5 text-pretty text-muted-foreground"
/** A section's or a step's name. On a phone it grows with the controls. */
export const GCP_TITLE = "text-base/6 font-medium sm:text-sm/5"

/** A named link stays on one line. A bare address may break. */
export function GcpExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className={cn(GCP_LINK, children !== href && "whitespace-nowrap")}
		>
			{children}
			{/* A word joiner in a no-wrap span: the icon never wraps away from the last word. */}
			<span className="whitespace-nowrap">
				{"⁠"}
				<ExternalLinkIcon size={12} className="ml-1 inline align-[-1px]" />
			</span>
		</a>
	)
}

/** An identifier inside a sentence: mono without a chip, so punctuation sits tight against it. */
export function GcpMono({ children }: { children: React.ReactNode }) {
	return <span className="font-mono whitespace-nowrap text-foreground">{children}</span>
}

/**
 * A shell command to copy: a code chip with its copy button, on one line where the width allows.
 * Too long for its line, it breaks between its words and never inside one: a flag or a name split
 * at a hyphen reads as another.
 */
export function GcpCommand({ children }: { children: string }) {
	return (
		<span className="inline-flex max-w-full items-start gap-0.5 align-top">
			<InlineCode className="min-w-0">
				{children.split(" ").map((word, index) => (
					<Fragment key={index}>
						{index === 0 ? null : " "}
						<span className="whitespace-nowrap">{word}</span>
					</Fragment>
				))}
			</InlineCode>
			<CopyButton value={children} label="command" toast={false} iconSize={12} className="size-5" />
		</span>
	)
}
