import { useState } from "react"
import { useOrganizationList } from "@clerk/clerk-react"
import { Cause, Exit, Option } from "effect"
import { FormDialog } from "@maple/ui/components/ui/form-dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Field, FieldDescription, FieldError, FieldLabel } from "@maple/ui/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@maple/ui/components/ui/radio-group"

import { CreateOrganizationRequest } from "@maple/domain/http"
import { MapleRegion as MapleRegionSchema, parseMapleRegion } from "@maple/domain/organization-regions"
import { RegionBadge } from "@/components/region/region-badge"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { useAtomSet } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	currentRegion,
	hasMultipleRegions,
	MAPLE_REGION_LABELS,
	type MapleRegion,
	regionAppUrl,
} from "@/lib/region"

/**
 * Creates an organization on the server, so it starts life with its region set. Where regions
 * exist, the region is chosen here and cannot be changed afterwards.
 */
export function CreateOrganizationDialog({
	open,
	onOpenChange,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const { setActive } = useOrganizationList()
	const [name, setName] = useState("")
	const [region, setRegion] = useState<MapleRegion>(currentRegion)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const createOrganization = useAtomSet(MapleApiAtomClient.mutation("organizationCreation", "create"), {
		mode: "promiseExit",
	})

	const handleOpenChange = (next: boolean) => {
		onOpenChange(next)
		if (!next) {
			setName("")
			setRegion(currentRegion)
			setErrorMessage(null)
		}
	}

	const [create, isCreating] = useAsyncAction(async () => {
		if (!setActive) return
		setErrorMessage(null)
		const result = await createOrganization({
			payload: new CreateOrganizationRequest({ name: name.trim(), region }),
		})
		if (Exit.isFailure(result)) {
			const error = Cause.findErrorOption(result.cause)
			setErrorMessage(Option.isSome(error) ? error.value.message : "Failed to create organization")
			return
		}
		await setActive({ organization: result.value.orgId })
		const url = region === currentRegion ? undefined : regionAppUrl(region)
		if (url !== undefined) window.location.assign(`${url}/`)
		else window.location.reload()
		// Stay pending while the page navigates away.
		return new Promise<never>(() => {})
	})
	const handleSubmit = () => {
		if (!isCreating) void create()
	}

	return (
		<FormDialog
			open={open}
			onOpenChange={handleOpenChange}
			title="Create Organization"
			description="Create a new organization to collaborate with your team."
			onSubmit={handleSubmit}
			submitLabel="Create"
			pending={isCreating}
			submitDisabled={!name.trim()}
			className="sm:max-w-md"
		>
			<Input
				placeholder="Organization name"
				value={name}
				maxLength={100}
				onChange={(e) => setName(e.target.value)}
				disabled={isCreating}
				required
				autoFocus
			/>
			{hasMultipleRegions && (
				<Field className="w-full items-stretch">
					<FieldLabel>Data region</FieldLabel>
					<RadioGroup
						value={region}
						onValueChange={(value) => setRegion(parseMapleRegion(value))}
						className="gap-0 divide-y divide-border overflow-hidden rounded-md border"
					>
						{MapleRegionSchema.literals.map((option) => (
							<label
								key={option}
								htmlFor={`org-region-${option}`}
								className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-accent/40 has-[[data-checked]]:bg-accent/64"
							>
								<RegionBadge region={option} />
								<span className="min-w-0 flex-1 text-sm">
									{MAPLE_REGION_LABELS[option].name}
								</span>
								<RadioGroupItem
									value={option}
									id={`org-region-${option}`}
									disabled={isCreating}
								/>
							</label>
						))}
					</RadioGroup>
					<FieldDescription>
						Telemetry is stored and processed only in this region. It cannot be changed later.
					</FieldDescription>
				</Field>
			)}
			{errorMessage && (
				<FieldError match className="text-sm">
					{errorMessage}
				</FieldError>
			)}
		</FormDialog>
	)
}
