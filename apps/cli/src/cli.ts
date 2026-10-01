import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { services, diagnose, serviceMap, topOps } from "./commands/services"
import { traces, trace, slowTraces } from "./commands/traces"
import { errors, error } from "./commands/errors"
import { logs, logPatterns } from "./commands/logs"
import { attributes } from "./commands/attributes"
import { metrics, query } from "./commands/data"
import { timeseries, breakdown, compare } from "./commands/analytics"
import { auth, login, logout, whoami } from "./commands/auth"
import { use } from "./commands/config"
import { start, stop, reset, checkpoint, restore } from "./commands/server"
import { schema } from "./commands/schema"
import { archive } from "./commands/archive"
import { deleteCommand } from "./commands/delete"
import { update } from "./commands/update"
import { OutputFormatSetting } from "./lib/output"

// One CLI, two backends. Local mode runs the query-engine helpers against the
// local chDB server; remote mode calls the workspace's v2 API, and its MCP tools
// where v2 has no resource (see core/operations.ts). The mode is resolved at
// runtime (core/mode.ts); `--remote`/`--local` are declared here as shared flags
// so parsing accepts them and `--help` lists them, and the resolver reads argv.
export const cli = Command.make("maple").pipe(
	Command.withDescription(
		"Query Maple telemetry (traces, logs, errors, services) from your terminal. " +
			"Runs against the local binary (`maple start`) or a remote workspace (`maple login`); " +
			"the mode is auto-detected and can be forced with --local / --remote.",
	),
	Command.withSharedFlags({
		remote: Flag.Boolean("remote").pipe(
			Flag.withDescription("Force remote mode (requires `maple login`)"),
			Flag.withDefault(false),
		),
		local: Flag.Boolean("local").pipe(
			Flag.withDescription("Force local mode (requires a running `maple start`)"),
			Flag.withDefault(false),
		),
		debug: Flag.Boolean("debug").pipe(
			Flag.withDescription("Print compiled SQL and per-query timing to stderr"),
			Flag.withDefault(false),
		),
	}),
	Command.withGlobalFlags([OutputFormatSetting]),
	Command.withSubcommands([
		// Server (local mode)
		start,
		stop,
		reset,
		checkpoint,
		restore,
		deleteCommand,
		schema,
		// Parquet archives (local mode)
		archive,
		// Self-update
		update,
		// Services
		services,
		diagnose,
		serviceMap,
		topOps,
		// Traces
		traces,
		trace,
		slowTraces,
		// Errors
		errors,
		error,
		// Logs
		logs,
		logPatterns,
		// Attributes & metrics
		attributes,
		metrics,
		// Analytics
		timeseries,
		breakdown,
		compare,
		// Raw SQL
		query,
		// Auth / config
		login,
		auth,
		logout,
		whoami,
		use,
	]),
)
