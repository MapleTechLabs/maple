import type { ComponentProps, ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"

import { DocsLink, EmptyActions } from "@/components/common/docs-link"
import type { DocsPage } from "@/lib/docs"

interface IntegrationLinkActionsProps {
	/** The `/integrations?integration=` id the button opens. */
	integration: string
	actionLabel: string
	actionVariant?: ComponentProps<typeof Button>["variant"]
	docsPage?: DocsPage
}

/** The integration-page button plus an optional docs link. */
export function IntegrationLinkActions({
	integration,
	actionLabel,
	actionVariant,
	docsPage,
}: IntegrationLinkActionsProps) {
	return (
		<EmptyActions>
			<Button
				size="sm"
				variant={actionVariant}
				render={<Link to="/integrations" search={{ integration }} />}
			>
				{actionLabel}
			</Button>
			{docsPage ? <DocsLink page={docsPage} /> : null}
		</EmptyActions>
	)
}

/** Full-page empty state for an integration-fed infra page with nothing connected (or nothing landing). */
export function IntegrationNotConnected({
	icon,
	title,
	description,
	...actions
}: IntegrationLinkActionsProps & { icon: ReactNode; title: ReactNode; description: ReactNode }) {
	return (
		<Empty className="py-16">
			<EmptyHeader>
				<EmptyMedia variant="icon">{icon}</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<IntegrationLinkActions {...actions} />
			</EmptyContent>
		</Empty>
	)
}
