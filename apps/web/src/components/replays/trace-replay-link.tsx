import { Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { getReplaysForTraceResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useSessionReplaysEnabled } from "@/hooks/use-session-replays-enabled"
import { EyeIcon } from "@/components/icons"

/**
 * Renders a "View Session Replay" link when a browser session observed this
 * trace. Silent (renders nothing) when there's no correlated replay, so it can
 * be dropped into any trace header unconditionally.
 */
export function TraceReplayLink({ traceId }: { traceId: string }) {
	const sessionReplaysEnabled = useSessionReplaysEnabled()
	const result = useAtomValue(getReplaysForTraceResultAtom({ data: { traceId } }))

	if (!sessionReplaysEnabled) return null

	return Result.builder(result)
		.onSuccess((data) => {
			const session = data.data[0]
			if (!session) return null
			return (
				<Link
					to="/replays/$sessionId"
					params={{ sessionId: session.sessionId }}
					className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted"
				>
					<EyeIcon className="size-3.5" /> View Session Replay
				</Link>
			)
		})
		// Stay silent on both loading and failure: a missing correlated replay and a
		// failed lookup should both render nothing rather than intrude on the header.
		.onError(() => null)
		.orElse(() => null)
}
