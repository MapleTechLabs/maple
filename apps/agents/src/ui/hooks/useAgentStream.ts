import { createAgentsClient, entity } from "@electric-ax/agents-runtime"
import type { EntityStreamDB } from "@electric-ax/agents-runtime"
import { useChat } from "@electric-ax/agents-runtime/react"
import { useEffect, useState } from "react"

export interface AgentStream {
	/** True while the agent is generating this turn (EntityTimelineState === "working"). */
	working: boolean
	/** The in-progress reply text, streaming token-by-token. Empty before the first token. */
	text: string
}

/**
 * Observe a single agent entity's timeline and expose its live streaming state.
 * Returns `{ working, text }` where `text` is the accumulated prose of the active run.
 */
export function useAgentStream(agentsUrl: string | null, entityUrl: string | null): AgentStream {
	const [db, setDb] = useState<EntityStreamDB | null>(null)

	useEffect(() => {
		if (!agentsUrl || !entityUrl) {
			setDb(null)
			return
		}

		let cancelled = false
		let observedDb: EntityStreamDB | null = null
		const client = createAgentsClient({ baseUrl: agentsUrl })

		client
			.observe(entity(entityUrl))
			.then((observed) => {
				observedDb = observed as EntityStreamDB
				if (cancelled) {
					observedDb.close()
					return
				}
				setDb(observedDb)
			})
			.catch((err) => {
				if (!cancelled) console.error(`Failed to observe entity ${entityUrl}:`, err)
			})

		return () => {
			cancelled = true
			observedDb?.close()
		}
	}, [agentsUrl, entityUrl])

	const { state, runs } = useChat(db)
	const working = state === "working"

	// The active run is the most recent one still streaming (status "started").
	let text = ""
	if (working && runs.length > 0) {
		const active = [...runs].reverse().find((r) => r.status === "started") ?? runs[runs.length - 1]
		text = (active?.texts ?? []).map((t) => t.text).join("")
	}

	return { working, text }
}
