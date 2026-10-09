import type { GcpResource } from "@maple/domain/http"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"

import { ExternalLinkIcon, GoogleCloudIcon } from "@/components/icons"

import { gcpConsolePage } from "./inventory"
import { gcpAssetTypeLabel, gcpResourceName, gcpStateLabel } from "./tabs"

/** What the inventory knows about a workload's resource, in the detail page's rail. */
export function GcpResourceCard({ resource }: { resource: GcpResource }) {
	const consolePage = gcpConsolePage(resource)
	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-sm font-medium">
					<GoogleCloudIcon size={14} />
					{gcpAssetTypeLabel(resource.assetType)}
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-1">
				<DetailRail.MetaRow label="Name" value={gcpResourceName(resource)} copyable />
				<DetailRail.MetaRow label="Project" value={resource.projectId} copyable />
				<DetailRail.MetaRow label="Location" value={resource.location} />
				<DetailRail.MetaRow
					label="State"
					value={resource.state === null ? null : gcpStateLabel(resource.state)}
				/>
				{Object.entries(resource.labels).map(([key, value]) => (
					<DetailRail.MetaRow key={key} label={key} value={value} />
				))}
				{consolePage === undefined ? null : (
					<a
						href={consolePage.href}
						target="_blank"
						rel="noreferrer"
						className="flex items-center gap-1.5 pt-2 text-xs text-primary hover:underline"
					>
						{consolePage.label} in Google Cloud
						<ExternalLinkIcon size={12} />
					</a>
				)}
			</CardContent>
		</Card>
	)
}
