import type React from "react"
import { ExternalLinkIcon } from "@/components/icons"
import { docsUrl, type DocsPage } from "@/lib/docs"

/** Quiet "Read the docs" link for empty states: the escape hatch next to the primary CTA. */
export function DocsLink({
	page,
	children = "Read the docs",
}: {
	readonly page: DocsPage
	readonly children?: React.ReactNode
}): React.ReactElement {
	return (
		<a
			href={docsUrl(page)}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1.5 text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
		>
			{children}
			<ExternalLinkIcon size={12} />
		</a>
	)
}

/** Centered action row: primary CTA(s) followed by docs links. */
export function EmptyActions({ children }: { readonly children: React.ReactNode }): React.ReactElement {
	return <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">{children}</div>
}
