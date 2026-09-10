import { Schema } from "effect"

import { describeCause } from "@/platform/describe-cause"

/** How much of the underlying reason survives into the message. */
const MAX_REASON_CHARS = 300

/** Internal workflow-start failure shared by both investigation entry points. */
export class FanoutStartError extends Schema.TaggedError<FanoutStartError>()(
	"@maple/api/errors/FanoutStartError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {
	/**
	 * The reason lands in the MESSAGE, not only in `cause`: every caller renders
	 * this through `summarizeCause`, which reads a reason's tag and message and
	 * stops there — so a Workflows error left in `cause` reaches no log line and
	 * no span, which is how three days of failing fan-out starts said only that
	 * they had failed.
	 */
	static fromCause(cause: unknown): FanoutStartError {
		const reason = describeCause(cause)?.split("\n")[0]?.trim().slice(0, MAX_REASON_CHARS)
		return new FanoutStartError({
			message: reason
				? `Investigation fanout failed to start: ${reason}`
				: "Investigation fanout failed to start",
			cause,
		})
	}
}
