import { MapleMark } from "@maple/ui/components/icons/maple-mark"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { cn } from "@maple/ui/lib/utils"
import {
	ONBOARDING_ROLE_IDS,
	ONBOARDING_ROLES,
	ROLE_DETAIL_MAX_LENGTH,
	type OnboardingRole,
} from "@/lib/onboarding-role"
import { DrawnCheck } from "./drawn-check"
import { PixelGlyph, type PixelGlyphName } from "./pixel-glyph"

const ROLE_GLYPH = {
	backend: "brackets-curly-dots",
	frontend: "laptop",
	devops_sre: "gear-2",
	eng_leader: "users-2",
	founder: "rocket",
	other: "pen-writing",
} satisfies Record<OnboardingRole, PixelGlyphName>

export function StepRole({
	value,
	detail,
	onChange,
	onContinue,
}: {
	value: OnboardingRole | null
	/** The free-text answer behind "Something else". */
	detail: string
	onChange: (role: OnboardingRole, detail: string) => void
	onContinue: () => void
}) {
	const needsDetail = value === "other" && detail.trim() === ""
	return (
		<div className="flex flex-1 flex-col items-center justify-center overflow-auto px-6 py-12">
			<div className="flex w-full max-w-3xl flex-col gap-8">
				<div className="space-y-3 text-center">
					<div aria-hidden="true" className="mx-auto mb-6 w-fit text-primary">
						<MapleMark size={56} />
					</div>
					<span className="text-[11px] font-semibold uppercase tracking-widest text-primary">
						Welcome to Maple
					</span>
					<h1 className="text-3xl font-semibold tracking-tight">What's your role?</h1>
					<p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
						Sets the default SDK snippet and the first pages we point you at.
					</p>
				</div>

				<fieldset className="grid min-w-0 gap-2.5 sm:grid-cols-2">
					<legend className="sr-only">Your role</legend>
					{ONBOARDING_ROLE_IDS.map((role) => {
						const active = value === role
						const option = ONBOARDING_ROLES[role]
						return (
							<label key={role} className="group relative cursor-pointer">
								<input
									type="radio"
									name="onboarding-role"
									className="peer sr-only"
									checked={active}
									aria-label={option.label}
									onChange={() => onChange(role, role === "other" ? detail : "")}
								/>
								<div
									className={cn(
										"flex h-full items-start gap-3 rounded-xl border p-4 transition-colors duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
										active
											? "border-primary bg-primary/5"
											: "border-border group-hover:border-foreground/30 group-hover:bg-foreground/[0.02]",
									)}
								>
									<PixelGlyph name={ROLE_GLYPH[role]} selected={active} />
									<div className="min-w-0 flex-1 pt-px">
										<span className="block text-sm font-semibold">{option.label}</span>
										<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
											{option.title}
										</span>
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

				{value === "other" && (
					<div className="space-y-2">
						<Label htmlFor="onboarding-role-detail">Your role</Label>
						<Input
							id="onboarding-role-detail"
							type="text"
							autoFocus
							autoComplete="organization-title"
							placeholder="e.g. Security engineer"
							value={detail}
							maxLength={ROLE_DETAIL_MAX_LENGTH}
							onChange={(event) => onChange("other", event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !needsDetail) onContinue()
							}}
						/>
					</div>
				)}

				<p
					aria-live="polite"
					aria-atomic="true"
					className="min-h-10 text-center text-xs leading-relaxed text-muted-foreground"
				>
					{value ? ONBOARDING_ROLES[value].greeting : "A little about you. Then a look inside."}
				</p>

				<div className="flex items-center justify-end">
					<Button
						size="lg"
						disabled={!value || needsDetail}
						onClick={onContinue}
						className="min-w-[180px]"
					>
						Continue
						<span className="ml-2">&rarr;</span>
					</Button>
				</div>
			</div>
		</div>
	)
}
