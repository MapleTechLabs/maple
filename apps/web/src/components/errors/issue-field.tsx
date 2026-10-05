import type React from "react"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"

/** A labelled field in the issue culprit panel, divided from the one above it. */
export function IssueField({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5 border-t pt-3.5 first:border-t-0 first:pt-0">
			<Eyebrow>{label}</Eyebrow>
			{children}
		</div>
	)
}
