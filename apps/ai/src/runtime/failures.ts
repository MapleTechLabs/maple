import { Cause } from "effect"
export const summarizeCause = (cause: Cause.Cause<unknown>): string =>
	Cause.prettyErrors(cause)
		.map((error) => error.message)
		.join("; ")
		.slice(0, 2_000)
