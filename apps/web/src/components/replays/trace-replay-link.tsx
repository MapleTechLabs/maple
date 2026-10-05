import { Link } from "@tanstack/react-router"
import { Button } from "@maple/ui/components/ui/button"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { getReplaysForTraceResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { EyeIcon } from "@/components/icons"

/**
 * Renders a "View Session Replay" link when a browser session observed this
 * trace. Silent (renders nothing) when there's no correlated replay, so it can
 * be dropped into any trace header unconditionally.
 */
export function TraceReplayLink({ traceId }: { traceId: string }) {
	const result = useAtomValue(getReplaysForTraceResultAtom({ data: { traceId } }))

	return (
		Result.builder(result)
			.onSuccess((data) => {
				const session = data.data[0]
				if (!session) return null
				return (
					<Button
						variant="outline"
						size="xs"
						render={<Link to="/replays/$sessionId" params={{ sessionId: session.sessionId }} />}
					>
						<EyeIcon className="size-3.5" /> View Session Replay
					</Button>
				)
			})
			// Stay silent on both loading and failure: a missing correlated replay and a
			// failed lookup should both render nothing rather than intrude on the header.
			.onError(() => null)
			.orElse(() => null)
	)
}
