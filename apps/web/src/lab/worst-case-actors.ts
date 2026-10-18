/**
 * The `/lab/worst-case` actors, resolved through the real directory lookup. Kept apart from
 * `worst-case-docs.ts` because `actor-chip` is a React module the Foldkit lab cannot load.
 */
import { ActorDocument } from "@maple/domain/http"
import { Schema } from "effect"

import { resolveActorIdentity, type ActorIdentity } from "@/components/errors/actor-chip"
import type { ActorDirectory } from "@/hooks/use-actor-directory"
import { uuid, WORST_CASE_PEOPLE } from "@/lab/worst-case-docs"
import type { WorstCaseMode } from "@/lab/worst-case-fixture"

const decodeActor = Schema.decodeUnknownSync(ActorDocument)

export function actorIdentities(mode: WorstCaseMode): ReadonlyArray<ActorIdentity> {
	const people = WORST_CASE_PEOPLE[mode]
	const directory: ActorDirectory = {
		lookup: (userId) => people.find((p) => p.userId === userId) ?? null,
		me: null,
		isLoaded: true,
	}
	return people.map((person, i) =>
		resolveActorIdentity(
			decodeActor({
				id: uuid(900 + i),
				type: "user",
				userId: person.userId,
				agentName: null,
				model: null,
				capabilities: [],
				lastActiveAt: null,
			}),
			directory,
		),
	)
}
