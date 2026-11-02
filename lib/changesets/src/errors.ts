import { Schema } from "effect"

/** A `.changeset/*.md` file that changesets itself would also reject. */
export class ChangesetParseError extends Schema.TaggedError<ChangesetParseError>()(
	"@maple/changesets/ChangesetParseError",
	{ message: Schema.String, file: Schema.String },
) {}

/** `.changeset/config.json` is missing, malformed, or breaks one of the config rules. */
export class ConfigError extends Schema.TaggedError<ConfigError>()("@maple/changesets/ConfigError", {
	message: Schema.String,
	problems: Schema.Array(Schema.String),
}) {}

/** The workspace root or one of its package manifests could not be read. */
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("@maple/changesets/WorkspaceError", {
	message: Schema.String,
	path: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** The changesets and the workspace disagree, e.g. a changeset names an unknown package. */
export class ReleasePlanError extends Schema.TaggedError<ReleasePlanError>()(
	"@maple/changesets/ReleasePlanError",
	{ message: Schema.String },
) {}

export class GitError extends Schema.TaggedError<GitError>()("@maple/changesets/GitError", {
	message: Schema.String,
	args: Schema.Array(Schema.String),
	stderr: Schema.String,
}) {}

export class FormatterError extends Schema.TaggedError<FormatterError>()("@maple/changesets/FormatterError", {
	message: Schema.String,
	formatter: Schema.String,
	stderr: Schema.String,
}) {}

export class JsonEditError extends Schema.TaggedError<JsonEditError>()("@maple/changesets/JsonEditError", {
	message: Schema.String,
	file: Schema.String,
}) {}

export class ChangelogError extends Schema.TaggedError<ChangelogError>()("@maple/changesets/ChangelogError", {
	message: Schema.String,
	module: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** A changesets feature this tool deliberately does not implement (pre mode, snapshots, commit). */
export class UnsupportedFeatureError extends Schema.TaggedError<UnsupportedFeatureError>()(
	"@maple/changesets/UnsupportedFeatureError",
	{ message: Schema.String, feature: Schema.String },
) {}

/** An expected non-zero exit that changesets reports the same way, e.g. "No unreleased changesets found." */
export class CommandExit extends Schema.TaggedError<CommandExit>()("@maple/changesets/CommandExit", {
	message: Schema.String,
	code: Schema.Number,
}) {}
