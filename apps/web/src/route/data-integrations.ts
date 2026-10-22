// The integrations that bring data in. They live under Sources; chat and alert connectors stay in
// Settings. One list for the redirect (`route/`) and the Sources pages (`page/integrations/embed.ts`).
export const DATA_INTEGRATIONS = ["cloudflare", "prometheus", "planetscale", "gcp", "aws", "railway", "supabase", "warpstream", "github"] as const
