import { HttpApiBuilder } from "effect/http-api"
import { MapleInternalApi, RolesUnavailableError } from "@maple/domain/http"
import { Effect } from "effect"

// Placeholder until the roles service lands: every endpoint answers 503.
const unavailable = () =>
	Effect.fail(new RolesUnavailableError({ message: "Custom roles are not available yet." }))

export const HttpRolesLive = HttpApiBuilder.group(MapleInternalApi, "roles", (handlers) =>
	Effect.succeed(
		handlers
			.handle("list", unavailable)
			.handle("members", unavailable)
			.handle("create", unavailable)
			.handle("update", unavailable)
			.handle("delete", unavailable)
			.handle("setMemberRole", unavailable),
	),
)
