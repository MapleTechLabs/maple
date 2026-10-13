import type React from "react"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"

/**
 * A grid, not a flex row with divider elements between the lanes. Fixed lane widths plus
 * standalone dividers only line up at one viewport; a grid column cannot strand a separator,
 * because the separator *is* the cell's left border.
 */
const STRIP = [
	"grid shrink-0 gap-y-5 px-1",
	"grid-cols-2 xl:grid-cols-4",
	"[&>*]:border-l [&>*]:pl-6",
	// 2-up: every odd cell starts a row.
	"[&>*:nth-child(odd)]:border-l-0 [&>*:nth-child(odd)]:pl-0",
	// 4-up: only the first cell does, so the odd rule has to be undone.
	"xl:[&>*:nth-child(odd)]:border-l xl:[&>*:nth-child(odd)]:pl-6",
	"xl:[&>*:first-child]:border-l-0 xl:[&>*:first-child]:pl-0",
].join(" ")

/** The labelled 2-up / 4-up fact row shared by the issue and investigation pages. */
export function FactStrip({ children }: { children: React.ReactNode }) {
	return <div className={STRIP}>{children}</div>
}

export function FactLane({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<Eyebrow>{label}</Eyebrow>
			<div className="min-w-0 text-sm">{children}</div>
		</div>
	)
}
