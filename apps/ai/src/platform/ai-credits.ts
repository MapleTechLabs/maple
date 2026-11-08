import { Array as Arr, String as Str } from "effect"
/**
 * How a model Maple ran on is named to Autumn's AI credit system.
 *
 * Autumn prices `track_tokens` from models.dev, keyed `<provider>/<model>`: the first path segment
 * is the models.dev provider and the rest its model key. Workers AI ids keep their `@cf/` prefix,
 * which is how models.dev lists them; everything else ran on OpenRouter.
 */
const WORKERS_AI_PREFIX = "@cf/"

/**
 * The configured model id, not the response's: OpenRouter can answer with a dated slug models.dev
 * does not list. Routing variants (`:nitro`, `:floor`) pick a provider, not a model, and are not
 * part of the models.dev key.
 */
export const autumnModelId = (model: string): string => {
	if (Str.startsWith(WORKERS_AI_PREFIX)(model)) return `cloudflare-workers-ai/${model}`
	return `openrouter/${Arr.headNonEmpty(Str.split(":")(model))}`
}
