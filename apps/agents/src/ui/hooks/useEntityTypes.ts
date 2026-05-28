import { useEffect, useState } from "react"

export interface EntityType {
	name: string
	description: string
	serve_endpoint?: string | null
}

/** Load the registered agent types from the agents-server (for the "add agent" menu). */
export function useEntityTypes(agentsUrl: string | null) {
	const [types, setTypes] = useState<EntityType[]>([])

	useEffect(() => {
		if (!agentsUrl) return
		fetch(`${agentsUrl}/_electric/entity-types`)
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`)
				return r.json()
			})
			// Only show agents this runtime actually serves — the server also
			// registers built-in system types (e.g. "principal") with no endpoint.
			.then((data) => setTypes((data as EntityType[]).filter((t) => t.serve_endpoint)))
			.catch((err) => console.error("Failed to load entity types:", err))
	}, [agentsUrl])

	return types
}
