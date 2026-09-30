import { Schema } from "effect"

// The v1 `/api/onboarding` group was retired once the quick-start wizard moved
// to client-local state. The persistence error stays because `OnboardingService`
// uses it; the checklist exposes its own v2 contract (`./v2/onboarding-checklist`).

export class OnboardingPersistenceError extends Schema.TaggedError<OnboardingPersistenceError>()(
	"@maple/http/errors/OnboardingPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}
