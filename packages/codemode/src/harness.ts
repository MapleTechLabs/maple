import { DEFAULT_OUTPUT_CAP_BYTES } from "./types.ts"

/**
 * Build the source of the dynamic-worker module that runs the model's code.
 *
 * The model's code is spliced **directly** into an async IIFE in the module
 * body — there is no runtime `eval`/`new Function`; the snippet simply *is* the
 * module. The only capability exposed is `env.MAPLE.call(name, input)` (an RPC
 * stub back to the supervisor); outbound network is blocked by the loader
 * (`globalOutbound: null`). `console.*` output and the IIFE's return value are
 * captured inside the isolate and shipped back as JSON via the fetch response,
 * so we never depend on capturing the parent's console.
 *
 * Splicing untrusted source is safe here precisely because the isolate has no
 * authority beyond `maple.*` (already the model's authority) and is bounded by
 * CPU/subrequest limits — the worst a hostile snippet can do is fail its own
 * isolate.
 */
export const buildHarnessModule = (userCode: string, capBytes = DEFAULT_OUTPUT_CAP_BYTES): string => {
	const cap = Math.max(1000, Math.floor(capBytes))
	return `export default {
  async fetch(request, env) {
    const __cap = ${cap};
    const __logs = [];
    let __bytes = 0;
    let __truncated = false;
    const __push = (level, args) => {
      if (__truncated) { return; }
      let line;
      try {
        line = args.map((a) => {
          if (typeof a === "string") { return a; }
          try { return JSON.stringify(a); } catch (_e) { return String(a); }
        }).join(" ");
      } catch (_e) { line = "[unserializable log]"; }
      const prefix = level === "log" ? "" : "[" + level + "] ";
      line = prefix + line;
      const room = __cap - __bytes;
      if (room <= 0) { __truncated = true; __logs.push("[output truncated]"); return; }
      if (line.length > room) { line = line.slice(0, room) + " ...[truncated]"; __truncated = true; }
      __bytes += line.length;
      __logs.push(line);
      if (__truncated) { __logs.push("[output truncated]"); }
    };
    const console = {
      log: (...a) => __push("log", a),
      info: (...a) => __push("info", a),
      warn: (...a) => __push("warn", a),
      error: (...a) => __push("error", a),
      debug: (...a) => __push("debug", a),
    };
    const maple = new Proxy({}, {
      get(_t, prop) {
        if (typeof prop !== "string") { return undefined; }
        return async (input) => {
          const r = await env.MAPLE.call(prop, input == null ? {} : input);
          if (r && r.ok) { return r.value; }
          const err = new Error((r && r.error && r.error.message) || ("maple." + prop + " failed"));
          err.name = (r && r.error && r.error.name) || "MapleToolError";
          throw err;
        };
      },
    });
    let __return;
    let __error = null;
    try {
      __return = await (async () => {
${userCode}
      })();
    } catch (e) {
      __error = {
        name: (e && e.name) || "Error",
        message: (e && e.message) || String(e),
        stack: e && e.stack ? String(e.stack).slice(0, 2000) : undefined,
      };
    }
    let __serialized;
    try { __serialized = __return === undefined ? undefined : JSON.parse(JSON.stringify(__return)); }
    catch (_e) { __serialized = String(__return); }
    return Response.json({ logs: __logs, returnValue: __serialized, error: __error });
  },
};
`
}
