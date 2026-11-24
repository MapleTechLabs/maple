import { String as Str } from "effect"
import { ONBOARDING_TEST_TRACE_SERVICE } from "@maple/domain/onboarding-checklist"

/** The service onboarding's "Send test trace" reports as. */
export const TEST_TRACE_SERVICE = ONBOARDING_TEST_TRACE_SERVICE

/** A service the org runs itself: not a seeded `demo-` one, nor onboarding's test trace. */
export const isOwnService = (serviceName: string): boolean =>
	!Str.startsWith("demo-")(serviceName) && serviceName !== TEST_TRACE_SERVICE
