import type { ReactNode } from "react"
import { Panel, PanelBody, PanelHeader } from "@maple/ui/components/ui/panel"

interface SectionCardProps {
	title: string
	/** Trailing header slot, typically a "View all →" link. */
	action?: ReactNode
	children: ReactNode
	className?: string
}

/**
 * Quiet bordered card for the Overview tab's secondary sections (open issues,
 * recent deploys). Header typography matches the StatRail eyebrows so the strip
 * and the cards read as one system.
 */
export function SectionCard({ title, action, children, className }: SectionCardProps) {
	return (
		<Panel className={className}>
			<PanelHeader title={title} action={action} />
			<PanelBody>{children}</PanelBody>
		</Panel>
	)
}
