/**
 * The typed client for the shared `TodoApi`, as an effect-atom service.
 *
 * `AtomHttpApi.Service` derives `.query(group, method, req)` and
 * `.mutation(group, method)` helpers straight from the same `HttpApi` the
 * backend implements — fully type-safe, no codegen. The `peer.service`
 * annotation on the outbound span draws the `todo-web → todo-api` service-map
 * edge in Maple.
 */
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { TodoApi } from "../../../shared/api.ts"
import { AtomHttpApi } from "./effect-atom.ts"

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4500"

export class TodoApiClient extends AtomHttpApi.Service<TodoApiClient>()(
	"@maple-examples/todo/TodoApiClient",
	{
		api: TodoApi,
		httpClient: FetchHttpClient.layer,
		baseUrl: apiBaseUrl,
		transformClient: (client) =>
			HttpClient.transform(client, (effect, request) =>
				request.url.startsWith(apiBaseUrl)
					? Effect.annotateSpans(effect, "peer.service", "todo-api")
					: effect,
			),
	},
) {}
