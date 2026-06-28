import { trace } from "@opentelemetry/api"
import { CHAT_FLUE_SERVICE_NAME } from "./telemetry.ts"

type SpanLike = { setAttribute(k: string, v: string | number | boolean): void }
export async function enterSpan<T>(
  name: string,
  fn: (span: SpanLike) => Promise<T>,
): Promise<T> {
  try {
    const { tracing } = await import("cloudflare:workers")
    return await tracing.enterSpan(name, fn)
  } catch {
    return trace.getTracer(CHAT_FLUE_SERVICE_NAME).startActiveSpan(name, fn)
  }
}