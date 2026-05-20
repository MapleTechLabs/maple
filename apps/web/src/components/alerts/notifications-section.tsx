import type { Dispatch, SetStateAction } from "react"
import { Link } from "@tanstack/react-router"

import type { AlertDestinationDocument } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"

import {
	AlertMultiSegmentedSelect,
	type AlertSegmentedOption,
} from "@/components/alerts/alert-segmented-select"
import { ProviderLogo } from "@/components/alerts/destination-provider"
import { SectionLabel } from "@/components/alerts/signal-and-threshold-section"
import { destinationTypeLabels, type RuleFormState } from "@/lib/alerts/form-utils"
import { LoaderIcon, PaperPlaneIcon } from "@/components/icons"

interface NotificationsSectionProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	destinations: AlertDestinationDocument[]
	onSendTest: () => void
	testing: boolean
}

/**
 * Pick which destinations receive this rule's notifications, plus an optional
 * "Send test notification" that actually dispatches through the selected
 * channel(s). The hero's Test Rule button performs a no-notification preview;
 * this one is the destructive-ish "really send it" path.
 */
export function NotificationsSection({
	form,
	onChange,
	destinations,
	onSendTest,
	testing,
}: NotificationsSectionProps) {
	const hasDestinations = destinations.length > 0
	const hasSelection = form.destinationIds.length > 0

	return (
		<Card className="p-4">
			<div className="flex items-center justify-between gap-3">
				<SectionLabel>Notifications</SectionLabel>
				{hasDestinations && (
					<Button
						variant="ghost"
						size="sm"
						onClick={onSendTest}
						disabled={!hasSelection || testing}
						className="h-7 px-2 text-xs"
					>
						{testing ? (
							<LoaderIcon size={12} className="animate-spin" />
						) : (
							<PaperPlaneIcon size={12} />
						)}
						Send test
					</Button>
				)}
			</div>

			<div className="mt-3">
				{!hasDestinations ? (
					<p className="text-muted-foreground text-sm">
						No destinations yet.{" "}
						<Link
							to="/alerts"
							search={{ tab: "settings" }}
							className="underline underline-offset-4 hover:text-foreground"
						>
							Create one in Settings
						</Link>{" "}
						before saving.
					</p>
				) : (
					<AlertMultiSegmentedSelect<string>
						options={
							destinations.map((d) => ({
								value: d.id as unknown as string,
								icon: <ProviderLogo type={d.type} size={24} bare />,
								label: (
									<span className="flex items-center gap-2">
										<span className="font-medium">{d.name}</span>
										<span className="text-muted-foreground text-xs">
											{destinationTypeLabels[d.type]}
										</span>
									</span>
								),
							})) satisfies AlertSegmentedOption<string>[]
						}
						value={form.destinationIds as unknown as string[]}
						onChange={(values) =>
							onChange((c) => ({
								...c,
								destinationIds: values as typeof c.destinationIds,
							}))
						}
						aria-label="Notification destinations"
						size="sm"
					/>
				)}
			</div>
		</Card>
	)
}
