import type React from "react"
import { useState } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"

import { DocsLink, EmptyActions } from "@/components/common/docs-link"
import { PlusIcon } from "@/components/icons"
import { InstallHostModal, type InstallTab } from "@/components/infra/install-modal"
import type { DocsPage } from "@/lib/docs"

interface InfraSetupEmptyProps {
	readonly icon: React.ReactNode
	readonly title: React.ReactNode
	readonly description: React.ReactNode
	/** The install modal tab the primary button opens on. */
	readonly installTab: InstallTab
	readonly actionLabel: string
	readonly docs: DocsPage
	/** Extra links after the docs link. */
	readonly children?: React.ReactNode
}

/** "Nothing reporting yet" for a collector-fed infra page: install button + docs. */
export function InfraSetupEmpty({
	icon,
	title,
	description,
	installTab,
	actionLabel,
	docs,
	children,
}: InfraSetupEmptyProps): React.ReactElement {
	const [installOpen, setInstallOpen] = useState(false)

	return (
		<Empty className="py-16">
			<EmptyHeader>
				<EmptyMedia variant="icon">{icon}</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			<EmptyActions>
				<Button size="sm" onClick={() => setInstallOpen(true)}>
					<PlusIcon size={14} />
					{actionLabel}
				</Button>
				<DocsLink page={docs} />
				{children}
			</EmptyActions>
			<InstallHostModal open={installOpen} onOpenChange={setInstallOpen} defaultTab={installTab} />
		</Empty>
	)
}
