import type { Html, HtmlBuilder } from "foldkit/html"
import { highlightCode } from "../../lib/highlight"
import { highlight, highlightKey } from "../../page/investigations/conversation/kit/code-highlight"
import { codeBlock as fenceBlock } from "../../page/investigations/conversation/kit/view-code"
import { codeBlock } from "../../page/settings/kit/code-block"
import type * as CopyButton from "../../ui/copy-button"
import { kitSection } from "./kit-layout"

// Every highlighted surface, one sample per language the app shows: setup snippets, a chat
// fence and a JSON log body.

const SNIPPETS: ReadonlyArray<{ readonly label: string; readonly code: string }> = [
	{
		label: "shell",
		code: `curl -X POST https://ingest.maple.dev/v1/traces \\\n  -H "Authorization: Bearer $MAPLE_INGEST_KEY" \\\n  --data @payload.json # one span\nexport OTEL_SERVICE_NAME=checkout-api`,
	},
	{
		label: "typescript",
		code: `import { Effect } from "effect"\n\n// Export traces to Maple\nconst program = Effect.gen(function* () {\n  const order = yield* fetchOrder(42)\n  return order.total * 1.2\n}).pipe(Effect.withSpan("checkout"))`,
	},
	{
		label: "config.yaml",
		code: `exporters:\n  otlphttp:\n    endpoint: https://ingest.maple.dev # US region\n    headers:\n      authorization: "Bearer \${env:MAPLE_INGEST_KEY}"\n    timeout: 10s`,
	},
	{
		label: "maple-aws.tf",
		code: `resource "aws_iam_role" "maple" {\n  name               = "maple-read-only"\n  max_session_duration = 3600\n  assume_role_policy = data.aws_iam_policy_document.trust.json\n}`,
	},
]

const FENCE = `from opentelemetry import trace\n\ntracer = trace.get_tracer(__name__)\n\ndef get_order(id: int):\n    with tracer.start_as_current_span("get_order") as span:\n        span.set_attribute("order.id", id)  # tag it\n        return db.fetch(id) or None`

const LOG_BODY = JSON.stringify(
	{
		level: "error",
		message: "upstream timed out after 3000ms",
		attempt: 3,
		retryable: true,
		cause: null,
		http: { method: "POST", route: "/v1/orders/:id", status: 504 },
	},
	null,
	2,
)

const FENCE_HIGHLIGHTS = { [highlightKey("py", FENCE)]: highlight("py", FENCE) }

export const codeSection = <M>(
	h: HtmlBuilder<M>,
	copy: CopyButton.Model,
	toCopyMessage: (message: CopyButton.Message) => M,
	onCopy: (value: string) => M,
): Html =>
	kitSection(h, "Code", [
		h.div(
			[h.Class("grid gap-4 md:grid-cols-2")],
			SNIPPETS.map(({ label, code }) => codeBlock(h, { code, language: label, copy, toCopyMessage })),
		),
		fenceBlock(
			h,
			{
				highlights: FENCE_HIGHLIGHTS,
				onCopy,
				onDownload: onCopy,
			},
			FENCE,
			"py",
		),
		h.pre(
			[h.Class("font-mono text-ui leading-relaxed whitespace-pre-wrap break-words")],
			[h.code([h.InnerHTML(highlightCode(LOG_BODY, "json"))], [])],
		),
	])
