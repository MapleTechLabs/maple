/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * The `Argument` module defines typed positional command-line arguments for
 * Effect CLI applications. Arguments consume ordered values after a command name
 * and its flags, then parse them into the types your command handler expects.
 *
 * Use this module for required inputs such as file paths, directories, numbers,
 * dates, choices, secrets, and structured configuration files. Arguments can be
 * made optional, variadic, validated with Schema, transformed with pure or
 * effectful functions, and supplied from defaults, config, or prompts when
 * missing.
 *
 * **Gotchas**
 *
 * - Positional arguments are order-sensitive; compose them in the same order the
 *   user should type them.
 * - `variadic` arguments can consume more than one value, so place them where
 *   the remaining positional input belongs.
 * - Use {@link withDescription} and {@link withMetavar} to keep generated help
 *   text clear, especially when the parser name differs from the value users
 *   should provide.
 * - Boolean positional arguments are intentionally not provided. Prefer boolean
 *   flags, or use {@link choice} for explicit `"true"` / `"false"` values.
 *
 * @since 4.0.0
 */
export * as Argument from "./Argument.ts"

/**
 * The `CliError` module defines the structured error model used by the
 * unstable CLI parser and runner. It distinguishes command-line parse failures,
 * CLI definition problems, explicit help requests, and user handler failures so
 * applications can report errors consistently while still pattern matching on
 * the exact cause.
 *
 * **Common tasks**
 *
 * - Detect CLI errors at runtime with {@link isCliError}
 * - Represent parse failures such as unknown flags, missing required inputs, or
 *   invalid argument values
 * - Attach parse or validation errors to {@link ShowHelp} when the runner should
 *   render help text together with the failure
 * - Preserve command handler failures with {@link UserError}
 *
 * **Gotchas**
 *
 * - {@link ShowHelp} is a control-flow error, not a parse failure; it exits with
 *   code `0` for explicit help and `1` when it carries errors
 * - Duplicate option names between parent and child commands are rejected
 *   because the parent command claims the flag before the child can see it
 * - Suggestion-bearing errors keep suggestions separate from the primary cause
 *   so help renderers can decide how much guidance to display
 *
 * @since 4.0.0
 */
export * as CliError from "./CliError.ts"

/**
 * The `CliOutput` module provides the formatting service used by Effect CLI
 * applications to turn parsed CLI metadata and failures into terminal text.
 * It renders help documents, parser errors, grouped errors, and version output,
 * while allowing applications and tests to replace the formatter through a
 * `Context` service or `Layer`.
 *
 * **Common tasks**
 *
 * - Render generated {@link HelpDoc} values for `--help` output
 * - Display parser failures and validation errors from CLI programs
 * - Customize output for plain text, colored terminals, tests, or alternate
 *   formats
 * - Format version strings consistently with the rest of CLI output
 *
 * **Gotchas**
 *
 * - Color output is auto-detected from `process.stdout.isTTY` and `NO_COLOR`,
 *   but can be forced with {@link defaultFormatter}
 * - Help tables measure visible width after stripping ANSI escape codes, so
 *   colored output stays aligned with plain output
 *
 * @since 4.0.0
 */
export * as CliOutput from "./CliOutput.ts"

/**
 * The `Command` module provides the core building block for defining and
 * running Effect-based command-line applications. A `Command` combines a name,
 * typed flags and positional arguments, optional subcommands, metadata for help
 * output, and an effectful handler.
 *
 * **Common tasks**
 *
 * - Create commands with {@link make}
 * - Add handlers with {@link withHandler}
 * - Build nested command trees with {@link withSubcommands}
 * - Share parent flags with subcommands using {@link withSharedFlags}
 * - Add command-scoped global flags with {@link withGlobalFlags}
 * - Attach help metadata with {@link withDescription}, {@link withShortDescription},
 *   {@link withAlias}, and {@link withExamples}
 * - Provide handler dependencies with {@link provide}, {@link provideSync},
 *   {@link provideEffect}, and {@link provideEffectDiscard}
 * - Execute commands with {@link run} or test them with {@link runWith}
 *
 * **Gotchas**
 *
 * - `withSharedFlags` accepts only flags, not positional arguments, and the
 *   parsed values are available to descendants by yielding the parent command.
 * - Shared flags may be written before or after the selected subcommand name.
 * - Duplicate flags across command scopes are rejected so parsing and help
 *   output remain unambiguous.
 * - `runWith` is the preferred entry point for tests because it accepts an
 *   explicit argument array instead of reading from the `Stdio` service.
 *
 * @since 4.0.0
 */
export * as Command from "./Command.ts"

/**
 * Shell completion descriptors and script generation for the unstable CLI API.
 *
 * @since 4.0.0
 */
export * as Completions from "./Completions.ts"

/**
 * The `Flag` module provides typed command-line options for Effect CLI
 * applications. A `Flag<A>` describes how to read one named option from the
 * parsed command line, validate it, and produce a value of type `A`.
 *
 * Use flags for inputs that are naturally named options, such as ports,
 * verbosity switches, configuration files, output directories, enum-like
 * choices, secrets, and repeated values. Constructors such as {@link string},
 * {@link boolean}, {@link integer}, {@link file}, and {@link fileSchema}
 * define the accepted input shape, while combinators add aliases, defaults,
 * optionality, fallback config or prompts, validation, and typed mapping.
 *
 * Flag names are rendered as long options, for example `Flag.integer("port")`
 * parses `--port 8080`. Boolean flags also support the disabled form shown by
 * this module's boolean documentation, and repeated flags are modeled with the
 * repetition combinators instead of by manually inspecting raw arguments. Help
 * text is generated from flag metadata, so prefer {@link withDescription} and
 * {@link withMetavar} when a flag's value, format, or file-system expectation
 * would otherwise be ambiguous.
 *
 * @since 4.0.0
 */
export * as Flag from "./Flag.ts"

/**
 * The `GlobalFlag` module defines flags that are available to every command in
 * an Effect CLI application. Global flags are useful for cross-cutting command
 * line behavior such as printing help, showing the application version,
 * generating shell completions, or configuring shared handler settings like the
 * minimum log level.
 *
 * **Common tasks**
 *
 * - Create an action flag with {@link action} for side effects that should run
 *   before the selected command, such as `--help` or `--version`
 * - Create a setting flag with {@link setting} for values that should be made
 *   available to command handlers through the Effect context
 * - Reuse the built-in {@link Help}, {@link Version}, {@link Completions}, and
 *   {@link LogLevel} flags when constructing command runners
 *
 * **Gotchas**
 *
 * - Action flags are intended to perform their effect and exit instead of
 *   continuing into the command handler
 * - Setting flags allocate a distinct context service for each call to
 *   {@link setting}, so reuse exported settings when handlers need to read the
 *   same parsed global value
 *
 * @since 4.0.0
 */
export * as GlobalFlag from "./GlobalFlag.ts"

/**
 * The `HelpDoc` module defines the structured documentation model used by the
 * unstable CLI package to describe command help. A `HelpDoc` value captures the
 * user-facing parts of a command, including its description, usage string,
 * positional arguments, flags, global flags, subcommands, and examples.
 *
 * **Common tasks**
 *
 * - Build help data from command definitions before rendering it
 * - Pass command documentation to `CliOutput.Formatter` implementations
 * - Represent custom help output formats without changing command parsing
 * - Group subcommands and distinguish local flags from global flags
 *
 * **Gotchas**
 *
 * - `HelpDoc` is format-agnostic; layout, ANSI styling, and table alignment are
 *   handled by the output formatter
 * - Optional argument and flag descriptions use `Option.Option<string>`, while
 *   optional sections are omitted when they have no entries
 * - Long names, aliases, and descriptions may require formatter-specific width
 *   handling when rendering terminal help
 *
 * @since 4.0.0
 */
export * as HelpDoc from "./HelpDoc.ts"

/**
 * The `Param` module defines the shared parser tree used by the unstable CLI
 * `Argument` and `Flag` modules. A `Param<Kind, A>` describes how to consume
 * either positional arguments or named flags from parsed command-line input and
 * return a typed value.
 *
 * **Common tasks**
 *
 * - Build primitive CLI inputs such as strings, booleans, numbers, choices,
 *   paths, files, and redacted values
 * - Attach help metadata with aliases and descriptions
 * - Transform parsed values with pure or effectful validation
 * - Model missing inputs with `Option`, defaults, config fallbacks, or prompts
 * - Accept repeated inputs with variadic, bounded, and non-empty parameters
 *
 * **Gotchas**
 *
 * - The `Kind` type parameter (`"argument"` or `"flag"`) keeps positional
 *   arguments and flags separate while allowing the implementation and
 *   combinators to be shared.
 * - Combinators preserve the parameter kind, so an argument parameter cannot be
 *   accidentally composed into a flag parameter or the reverse.
 * - Parsers return both the remaining positional arguments and the parsed
 *   value; this is important for argument ordering and variadic parameters.
 * - Some parsers require CLI services such as filesystem, path, terminal, or
 *   child-process support through the parsing environment.
 *
 * @since 4.0.0
 */
export * as Param from "./Param.ts"

/**
 * Primitive types for CLI parameter parsing.
 *
 * Primitives handle the low-level parsing of string input into typed values.
 * Most users should use the higher-level `Argument` and `Flag` modules instead.
 *
 * This module is primarily useful for:
 * - Creating custom primitive types
 * - Understanding how CLI parsing works internally
 * - Advanced customization of parsing behavior
 *
 * @since 4.0.0
 */
export * as Primitive from "./Primitive.ts"

/**
 * The `Prompt` module provides composable, effectful building blocks for
 * interactive command-line questions. A `Prompt<A>` describes terminal UI that
 * renders frames, reads keyboard input, validates responses, and eventually
 * produces a value of type `A`.
 *
 * **Common tasks**
 *
 * - Ask for text, password, hidden, list, confirm, toggle, number, or date input
 * - Let users choose from select, autocomplete, multi-select, and file prompts
 * - Combine prompts with {@link all}, {@link map}, and {@link flatMap}
 * - Build specialized prompts with {@link custom}
 * - Run a prompt against the current terminal with {@link run}
 *
 * **Gotchas**
 *
 * - Prompts require terminal services and may fail with `Terminal.QuitError`
 *   when input ends or the prompt is quit
 * - Rendering is frame-based: custom prompts must return ANSI output from
 *   `render` and matching ANSI clearing output from `clear`
 * - Choices and file lists are paged by `maxPerPage`, so keyboard navigation
 *   and filtering should account for hidden off-page entries
 * - `password` and `hidden` return `Redacted` values; unwrap them only at the
 *   boundary where the secret is needed
 *
 * @since 4.0.0
 */
export * as Prompt from "./Prompt.ts"
