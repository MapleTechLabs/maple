import { Schema } from "effect"

// The integrations that bring data in. They live under Sources; chat and alert connectors stay in
// Settings. One list for the redirect (`route/`) and the Sources pages (`page/integrations/embed.ts`).
export const DATA_INTEGRATIONS = [
	"cloudflare",
	"prometheus",
	"planetscale",
	"gcp",
	"aws",
	"railway",
	"vercel",
	"supabase",
	"warpstream",
	"github",
] as const
export const DataIntegration = Schema.Literals(DATA_INTEGRATIONS)
export type DataIntegration = typeof DataIntegration.Type
export const isDataIntegration = Schema.is(DataIntegration)
