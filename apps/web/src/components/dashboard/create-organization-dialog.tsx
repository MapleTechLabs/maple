import { useState, type FormEvent } from "react"
import { useOrganizationList } from "@clerk/clerk-react"
import { Cause, Exit, Option } from "effect"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Button } from "@maple/ui/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@maple/ui/components/ui/radio-group"

import { CreateOrganizationRequest } from "@maple/domain/http"
import { parseMapleRegion } from "@maple/domain/organization-regions"
import { RegionBadge } from "@/components/region/region-badge"
import { useAtomSet } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	currentRegion,
	hasMultipleRegions,
	MAPLE_REGION_LABELS,
	type MapleRegion,
	regionAppUrl,
} from "@/lib/region"

const REGION_OPTIONS: ReadonlyArray<MapleRegion> = ["us", "eu"]

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
	const [isCreating, setIsCreating] = useState(false)
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

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (isCreating || !setActive) return
		setIsCreating(true)
		setErrorMessage(null)
		const result = await createOrganization({
			payload: new CreateOrganizationRequest({ name: name.trim(), region }),
		})
		if (Exit.isFailure(result)) {
			const error = Cause.findErrorOption(result.cause)
			setErrorMessage(Option.isSome(error) ? error.value.message : "Failed to create organization")
			setIsCreating(false)
			return
		}
		await setActive({ organization: result.value.orgId })
		const url = region === currentRegion ? undefined : regionAppUrl(region)
		if (url !== undefined) window.location.assign(`${url}/`)
		else window.location.reload()
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md" render={<form onSubmit={handleSubmit} />}>
				<DialogHeader>
					<DialogTitle>Create Organization</DialogTitle>
					<DialogDescription>
						Create a new organization to collaborate with your team.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="space-y-4">
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
						<div className="space-y-2">
							<Label>Data region</Label>
							<RadioGroup
								value={region}
								onValueChange={(value) => setRegion(parseMapleRegion(value))}
								className="gap-0 divide-y divide-border overflow-hidden rounded-lg border"
							>
								{REGION_OPTIONS.map((option) => (
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
							<p className="text-xs text-muted-foreground">
								Telemetry is stored and processed only in this region. It cannot be changed
								later.
							</p>
						</div>
					)}
					{errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
				</DialogPanel>
				<DialogFooter>
					<Button type="submit" disabled={isCreating || !name.trim()}>
						{isCreating ? "Creating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
