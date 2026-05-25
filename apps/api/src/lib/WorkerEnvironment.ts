// Re-export effect-cf's `WorkerEnvironment` Context tag. Inside `Worker.make`
// the layer is supplied automatically from the worker `env`; this re-export is
// for code that provides it manually (e.g. the Durable Object agent in
// `agent.ts`, and the `@maple/api/alerting` barrel).
export { WorkerEnvironment } from "@maple/effect-cf"
