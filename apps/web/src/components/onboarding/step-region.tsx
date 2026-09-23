import { useState } from "react"
import { useOrganization } from "@clerk/clerk-react"
import { Cause, Exit, Option } from "effect"
import { MapleMark } from "@maple/ui/components/icons/maple-mark"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { ChooseOrganizationRegionRequest } from "@maple/domain/http"

import { useAtomSet } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { currentRegion, MAPLE_REGION_LABELS, type MapleRegion, regionAppUrl } from "@/lib/region"
import { DrawnCheck } from "./drawn-check"
import { PixelGlyph } from "./pixel-glyph"

const REGION_OPTIONS: ReadonlyArray<MapleRegion> = ["us", "eu"]

const hostOf = (url: string | undefined) => (url === undefined ? undefined : new URL(url).host)

/**
 * The first onboarding step for an organization created without a region (the one Clerk makes at
 * sign-up). Choosing this region continues here; choosing the other one moves onboarding there.
 */
export function StepRegion() {
	const { organization } = useOrganization()
	const [region, setRegion] = useState<MapleRegion>(currentRegion)
	const [isSaving, setIsSaving] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const chooseRegion = useAtomSet(MapleApiAtomClient.mutation("organizations", "chooseRegion"), {
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

				<fieldset className="grid min-w-0 gap-2.5 sm:grid-cols-2">
					<legend className="sr-only">Data region</legend>
					{REGION_OPTIONS.map((option) => {
						const active = region === option
						const host = hostOf(regionAppUrl(option))
						return (
							<label key={option} className="group relative cursor-pointer">
								<input
									type="radio"
									name="onboarding-region"
									className="peer sr-only"
									checked={active}
									disabled={isSaving}
									aria-label={MAPLE_REGION_LABELS[option].name}
									onChange={() => setRegion(option)}
								/>
								<div
									className={cn(
										"flex h-full items-start gap-3 rounded-xl border p-4 transition-colors duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
										active
											? "border-primary bg-primary/5"
											: "border-border group-hover:border-foreground/30 group-hover:bg-foreground/[0.02]",
									)}
								>
									<PixelGlyph name="earth" selected={active} />
									<div className="min-w-0 flex-1 pt-px">
										<span className="block text-sm font-semibold">
											{MAPLE_REGION_LABELS[option].name}
										</span>
										{host !== undefined && (
											<span className="mt-1 block font-mono text-xs text-muted-foreground">
												{host}
											</span>
										)}
									</div>
									<DrawnCheck
										checked={active}
										className={cn("mt-0.5", !active && "opacity-0")}
									/>
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
