import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { OnboardingLab } from "@/lab/onboarding/onboarding-lab"

// `?step=N` opens the preview on a later step directly, for looking at one
// step without clicking through the ones before it.
const OnboardingLabSearch = Schema.Struct({ step: Schema.optional(Schema.Number) })

export const Route = createFileRoute("/lab/onboarding")({
	component: OnboardingLabPage,
	validateSearch: Schema.toStandardSchemaV1(OnboardingLabSearch),
})

function OnboardingLabPage() {
	const { step } = Route.useSearch()
	return <OnboardingLab initialStep={step} />
}
