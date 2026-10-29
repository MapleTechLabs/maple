import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/infra/supabase/$projectRef`: one project's charts; a new ref is a new instance. */
export const entry = definePage(
	"InfraSupabaseProject",
	{ Model, Message },
	{ routes: ["InfraSupabaseProject"], key: (route) => `InfraSupabaseProject:${route.projectRef}` },
)

export const page = entry.lazy(() => import("./implementation"))
