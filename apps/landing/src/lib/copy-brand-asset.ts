import { writeClipboardText } from "@maple/ui/lib/clipboard"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"

/**
 * A published brand file onto the clipboard; false when the fetch or the write fails. The file, not
 * the rendered node, so the clipboard and the download are the same bytes. The header loads this
 * on a pick, so the HTTP client stays off every page's first load.
 */
export const copyBrandAsset = (href: string): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
		const text = yield* Effect.flatMap(client.get(href), (response) => response.text)
		return yield* Effect.promise(() => writeClipboardText(text))
	}).pipe(
		// An island runtime takes no resources, so its one request is its own entry point.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(FetchHttpClient.layer),
		Effect.orElseSucceed(() => false),
	)
