import { useState } from "react"
import { useOrganization } from "@clerk/clerk-react"
import { Cause, Exit, Option } from "effect"
import { MapleMark } from "@maple/ui/components/icons/maple-mark"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { ChooseOrganizationRegionRequest } from "@maple/domain/http"

import { useAtomSet } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { RegionFlag } from "@/components/region/region-flag"
import { currentRegion, type MapleRegion, regionAppUrl } from "@/lib/region"
import { DrawnCheck } from "./drawn-check"

const REGION_OPTIONS: ReadonlyArray<MapleRegion> = ["us", "eu"]

/** Card copy and the colour a selected card takes, lifted from its flag so it reads on dark. */
const REGION_CARDS = {
	us: {
		name: "United States",
		place: "North America",
		residency: "Data stays in the US",
		accent: "#E5485B",
		check: "border-[#E5485B] bg-[#E5485B] text-white",
	},
	eu: {
		name: "European Union",
		place: "Frankfurt, Germany",
		residency: "Data stays in the EU",
		accent: "#5B7CFF",
		check: "border-[#5B7CFF] bg-[#5B7CFF] text-white",
	},
} as const satisfies Record<
	MapleRegion,
	{
		name: string
		place: string
		residency: string
		accent: string
		check: string
	}
>

/**
 * The first onboarding step for an organization created without a region (the one Clerk makes at
 * sign-up). Choosing this region continues here; choosing the other one moves onboarding there.
 */
export function StepRegion() {
	const { organization } = useOrganization()
	const [region, setRegion] = useState<MapleRegion>(currentRegion)
	const [isSaving, setIsSaving] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const chooseRegion = useAtomSet(MapleApiAtomClient.mutation("organizationRegion", "choose"), {
		mode: "promiseExit",
	})

	const handleContinue = async () => {
		if (isSaving) return
		setIsSaving(true)
		setErrorMessage(null)
		const result = await chooseRegion({ payload: new ChooseOrganizationRegionRequest({ region }) })
		if (Exit.isFailure(result)) {
			const error = Cause.findErrorOption(result.cause)
			setErrorMessage(Option.isSome(error) ? error.value.message : "Could not save the data region")
			setIsSaving(false)
			return
		}
		const url = region === currentRegion ? undefined : regionAppUrl(region)
		if (url !== undefined) {
			window.location.assign(`${url}/quick-start`)
			return
		}
		// The step closes once Clerk hands back the metadata with the region in it.
		await organization?.reload()
		setIsSaving(false)
	}

	return (
		<div className="flex flex-1 flex-col items-center justify-center overflow-auto px-6 py-12">
			<div className="flex w-full max-w-3xl flex-col gap-8">
				<div className="space-y-3 text-center">
					<div aria-hidden="true" className="mx-auto mb-6 w-fit text-primary">
						<MapleMark size={56} />
					</div>
					<span className="text-[11px] font-semibold uppercase tracking-widest text-primary">
						Before you start
					</span>
					<h1 className="text-3xl font-semibold tracking-tight">Where should your data live?</h1>
					<p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
						Each region is a separate Maple. Your telemetry, dashboards and alerts are stored and
						processed only in the one you pick.
					</p>
				</div>

				<fieldset className="grid min-w-0 gap-3 sm:grid-cols-2">
					<legend className="sr-only">Data region</legend>
					{REGION_OPTIONS.map((option) => {
						const active = region === option
						const card = REGION_CARDS[option]
						return (
							<label key={option} className="group relative cursor-pointer">
								<input
									type="radio"
									name="onboarding-region"
									className="peer sr-only"
									checked={active}
									disabled={isSaving}
									aria-label={card.name}
									onChange={() => setRegion(option)}
								/>
								<div
									style={{
										borderColor: active ? card.accent : undefined,
										backgroundColor: active ? `${card.accent}0F` : undefined,
									}}
									className={cn(
										"flex h-full flex-col gap-5 rounded-xl border p-5 transition-colors duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
										!active &&
											"border-border group-hover:border-foreground/30 group-hover:bg-foreground/[0.02]",
									)}
								>
									<div className="flex items-start justify-between">
										<RegionFlag
											region={option}
											className={cn(
												"h-12 w-18 transition-[opacity,filter] duration-150 motion-reduce:transition-none",
												!active &&
													"opacity-70 saturate-50 group-hover:opacity-100 group-hover:saturate-100",
											)}
										/>
										<DrawnCheck
											checked={active}
											className={active ? card.check : "opacity-0"}
										/>
									</div>
									<div className="space-y-1">
										<span className="block text-base font-semibold tracking-tight">
											{card.name}
										</span>
										<span className="block text-sm text-muted-foreground">
											{card.place}
										</span>
									</div>
									<div className="mt-auto flex">
										<span
											className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
											style={{
												color: active ? card.accent : undefined,
												borderColor: active ? `${card.accent}66` : undefined,
												backgroundColor: active ? `${card.accent}14` : undefined,
											}}
										>
											<span
												aria-hidden="true"
												className="size-1.5 rounded-full"
												style={{ backgroundColor: card.accent }}
											/>
											{card.residency}
										</span>
									</div>
								</div>
							</label>
						)
					})}
				</fieldset>

				<p
					aria-live="polite"
					aria-atomic="true"
					className={cn(
						"min-h-10 text-center text-xs leading-relaxed",
						errorMessage ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{errorMessage ?? "An organization stays in the region it starts in."}
				</p>

				<div className="flex items-center justify-end">
					<Button size="lg" disabled={isSaving} onClick={handleContinue} className="min-w-[180px]">
						{isSaving ? "Saving..." : "Continue"}
						{!isSaving && <span className="ml-2">&rarr;</span>}
					</Button>
				</div>
			</div>
		</div>
	)
}
