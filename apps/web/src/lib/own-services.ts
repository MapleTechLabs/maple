import { String as Str } from "effect"

/** The service onboarding's "Send test trace" reports as. */
export const TEST_TRACE_SERVICE = "maple-test"

/** A service the org runs itself: not a seeded `demo-` one, nor onboarding's test trace. */
export const isOwnService = (serviceName: string): boolean =>
	!Str.startsWith("demo-")(serviceName) && serviceName !== TEST_TRACE_SERVICE
