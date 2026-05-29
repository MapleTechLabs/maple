import * as Command from "effect/unstable/cli/Command"
import { services, diagnose, serviceMap } from "./commands/services"
import { traces, trace, slowTraces } from "./commands/traces"
import { errors, error } from "./commands/errors"
import { logs, logPatterns } from "./commands/logs"
import { attributes } from "./commands/attributes"
import { metrics, query } from "./commands/data"
import { serve } from "./commands/serve"

// Root command name is "maple" (not "maple-local"): in the release bundle this
// CLI is invoked by the `maple` server binary as a forwarded subcommand, so
// help/usage should read `maple services`, `maple traces`, etc.
export const cli = Command.make("maple").pipe(
	Command.withDescription(
		"Query the local Maple binary's telemetry (traces, logs, errors, services). " +
			"Targets http://127.0.0.1:4318 by default; override with MAPLE_LOCAL_URL.",
	),
	Command.withSubcommands([
		services,
		diagnose,
		serviceMap,
		traces,
		trace,
		slowTraces,
		errors,
		error,
		logs,
		logPatterns,
		attributes,
		metrics,
		query,
		serve,
	]),
)
