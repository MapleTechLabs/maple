import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { ArrowLeftIcon } from "@/components/icons"
import { ONBOARDING_INTENT_IDS, ONBOARDING_INTENTS, type OnboardingIntent } from "@/lib/onboarding-intent"
import { DrawnCheck } from "./drawn-check"
import { PixelGlyph, type PixelGlyphName } from "./pixel-glyph"

const INTENT_GLYPH = {
	traces: "square-activity-chart",
	logs: "file",
	metrics: "chart-bar-trend-up",
	errors: "triangle-warning",
	replays: "film",
	service_map: "nodes-3",
	infrastructure: "layers-3",
	alerts: "bell",
} satisfies Record<OnboardingIntent, PixelGlyphName>

export function StepIntent({
	value,
	onChange,
	onContinue,
	onBack,
}: {
	value: readonly OnboardingIntent[]
	onChange: (value: readonly OnboardingIntent[]) => void
	onContinue: () => void
	onBack: () => void
}) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
			<div className="w-full max-w-3xl space-y-7">
				<div className="space-y-3 text-center">
					<h1 className="text-3xl font-semibold tracking-tight">What do you want to see first?</h1>
					<p className="text-sm leading-relaxed text-muted-foreground">
						Pick any. Setup guidance follows what you choose.
					</p>
				</div>
				<fieldset className="grid min-w-0 gap-2.5 sm:grid-cols-2">
					<legend className="sr-only">Surfaces to start with — choose any that apply</legend>
					{ONBOARDING_INTENT_IDS.map((intent) => {
						const selected = value.includes(intent)
						const option = ONBOARDING_INTENTS[intent]
						return (
							<label key={intent} className="group relative cursor-pointer">
								<input
									type="checkbox"
									className="peer sr-only"
									checked={selected}
									aria-label={option.label}
									onChange={() =>
										onChange(
											selected
												? value.filter((item) => item !== intent)
												: [...value, intent],
										)
									}
								/>
								<div
									className={cn(
										"flex h-full items-start gap-3 rounded-xl border p-4 transition-colors duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
										selected
											? "border-primary bg-primary/5"
											: "border-border group-hover:border-foreground/30 group-hover:bg-foreground/[0.02]",
									)}
								>
									<PixelGlyph name={INTENT_GLYPH[intent]} selected={selected} />
									<div className="min-w-0 flex-1 pt-px">
										<span className="block text-sm font-semibold">{option.label}</span>
										<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
											{option.title}
										</span>
									</div>
									<DrawnCheck checked={selected} className="mt-0.5" />
								</div>
							</label>
						)
					})}
				</fieldset>
				<div
					className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-b pb-5 text-xs"
					aria-live="polite"
					aria-atomic="true"
				>
					{value.length === 0 ? (
						<span className="text-muted-foreground">Pick at least one.</span>
					) : (
						<>
							<span className="tabular-nums">{value.length} selected</span>
							<span className="text-muted-foreground">
								{value.map((intent) => ONBOARDING_INTENTS[intent].label).join(" · ")}
							</span>
						</>
					)}
				</div>
				<div className="flex items-center justify-between gap-3">
					<Button variant="ghost" onClick={onBack}>
						<ArrowLeftIcon size={14} />
						Back
					</Button>
					<Button size="lg" disabled={value.length === 0} onClick={onContinue}>
						Continue
					</Button>
				</div>
			</div>
		</div>
	)
}
