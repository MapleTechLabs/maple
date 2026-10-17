import type { ReactNode } from "react"

import { Eyebrow } from "@maple/ui/components/ui/eyebrow"

// Shared frame for the `/lab/kit/<group>` component gallery: one page per primitive group,
// one labelled section per primitive, deterministic content only (parity targets).
export function KitPage({
	title,
	description,
	children,
}: {
	title: string
	description: string
	children: ReactNode
}) {
	return (
		<div className="mx-auto flex max-w-5xl flex-col gap-10 p-8">
			<header className="flex flex-col gap-1">
				<h1 className="font-semibold text-lg">{title}</h1>
				<p className="text-muted-foreground text-sm">{description}</p>
			</header>
			{children}
		</div>
	)
}

export function KitSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section aria-label={title} className="flex flex-col gap-3">
			<Eyebrow variant="label" as="h2">
				{title}
			</Eyebrow>
			{children}
		</section>
	)
}

export function KitRow({ label, children }: { label?: string; children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-3">
			{label !== undefined ? (
				<span className="w-36 shrink-0 font-mono text-muted-foreground text-xs">{label}</span>
			) : null}
			{children}
		</div>
	)
}
