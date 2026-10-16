import { MapleMark } from "@maple/ui/components/icons/maple-mark"
import { Button } from "@maple/ui/components/ui/button"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Input } from "@maple/ui/components/ui/input"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"
import { OptionCard } from "@/components/common/option-card"
import {
	ONBOARDING_ROLE_IDS,
	ONBOARDING_ROLES,
	ROLE_DETAIL_MAX_LENGTH,
	type OnboardingRole,
} from "@/lib/onboarding-role"
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
					<Eyebrow variant="label" className="text-primary">
						Welcome to Maple
					</Eyebrow>
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
							<OptionCard
								key={role}
								type="radio"
								name="onboarding-role"
								checked={active}
								onChange={() => onChange(role, role === "other" ? detail : "")}
								label={option.label}
								title={option.label}
								description={option.title}
								media={<PixelGlyph name={ROLE_GLYPH[role]} selected={active} />}
							/>
						)
					})}
				</fieldset>

				{value === "other" && (
					<Field className="w-full items-stretch">
						<FieldLabel htmlFor="onboarding-role-detail">Your role</FieldLabel>
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
					</Field>
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
