import { DEFAULT_OUTPUT_CAP_BYTES } from "./types.ts"

/** Entry module of the sandbox worker. */
export const SANDBOX_MAIN_MODULE = "main.js"
const USER_MODULE = "user.js"

/**
 * Wrap the model's snippet as its OWN module that exports an async function of
 * `(maple, console)`. Because the snippet is the function body of a separate
 * module — not spliced into the harness's `fetch` scope — it cannot reach the
 * harness internals (`__logs`/`__cap`/`env`); a snippet that tries to break out
 * of the function (e.g. ending in `})();`) just makes this module fail to parse,
 * which surfaces as a crashed run rather than tampering with log/cap capture.
 */
const buildUserModule = (userCode: string): string =>
	`export default async function (maple, console) {\n${userCode}\n}\n`

/**
 * The harness module: installs a byte-capped `console` shim and a `maple` Proxy
 * (whose only capability is `env.MAPLE.call(name, input)` — an RPC stub back to
 * the supervisor; outbound network is blocked by the loader via
 * `globalOutbound: null`), runs the user module's exported function, and ships
 * `{ logs, returnValue, error }` back as JSON via the fetch response. Nothing
 * here depends on capturing the parent's console.
 */
const buildMainModule = (capBytes: number): string => {
	const cap = Math.max(1000, Math.floor(capBytes))
	return `import runUser from "./${USER_MODULE}";
export default {
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
    const __console = {
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
      __return = await runUser(maple, __console);
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

/**
 * Build the module set for the dynamic-worker sandbox: the harness entry
 * (`main.js`) plus the model's snippet as its own module (`user.js`). Splitting
 * them keeps the model's code out of the harness scope — see `buildUserModule`.
 */
export const buildSandboxModules = (
	userCode: string,
	capBytes = DEFAULT_OUTPUT_CAP_BYTES,
): Record<string, string> => ({
	[SANDBOX_MAIN_MODULE]: buildMainModule(capBytes),
	[USER_MODULE]: buildUserModule(userCode),
})
