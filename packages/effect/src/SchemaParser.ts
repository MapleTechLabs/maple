/**
 * The `SchemaParser` module turns schemas into reusable runtime operations for
 * constructing, validating, decoding, and encoding values. It is the execution
 * layer behind a schema's AST: parsers walk the schema structure, apply
 * transformations, honor parse options, run checks, and report failures as
 * `SchemaIssue.Issue` values.
 *
 * Use this module when you need a parser with a specific result shape:
 * `Effect` for effectful parsing and service requirements, `Promise` for
 * JavaScript interop, `Exit` or `Result` when failures should stay in data,
 * `Option` for yes/no validation, and synchronous helpers when throwing is the
 * desired boundary.
 *
 * Decoding reads from the encoded/input side of a schema into its decoded
 * `Type`, while encoding runs the schema in the opposite direction. The
 * `make*` helpers construct decoded values and apply constructor defaults before
 * validation. Parse options supplied when a parser is created are merged with
 * options supplied at call time, and schema-level parse annotations can further
 * refine behavior.
 *
 * @since 4.0.0
 */
import * as Arr from "./Array.ts"
import * as Cause from "./Cause.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import { identity, memoize } from "./Function.ts"
import * as InternalAnnotations from "./internal/schema/annotations.ts"
import * as Option from "./Option.ts"
import * as Predicate from "./Predicate.ts"
import * as Result from "./Result.ts"
import type * as Schema from "./Schema.ts"
import * as AST from "./SchemaAST.ts"
import * as Issue from "./SchemaIssue.ts"

const recurDefaults = memoize((ast: AST.AST): AST.AST => {
  switch (ast._tag) {
    case "Declaration": {
      const getLink = ast.annotations?.[AST.ClassTypeId]
      if (Predicate.isFunction(getLink)) {
        const link = getLink(ast.typeParameters)
        const to = recurDefaults(link.to)
        return AST.replaceEncoding(ast, to === link.to ? [link] : [new AST.Link(to, link.transformation)])
      }
      return ast
    }
    case "Objects":
    case "Arrays":
      return ast.recur((ast) => {
        const defaultValue = ast.context?.defaultValue
        if (defaultValue) {
          return AST.replaceEncoding(recurDefaults(ast), defaultValue)
        }
        return recurDefaults(ast)
      })
    case "Suspend":
      return ast.recur(recurDefaults)
    default:
      return ast
  }
})

/**
 * Creates an effectful maker for the schema's decoded type side.
 *
 * **Details**
 *
 * The returned function accepts constructor input, applies constructor defaults,
 * runs type-side validation unless checks are disabled, and fails with a
 * `SchemaIssue.Issue` when construction fails.
 *
 * @category Constructing
 * @since 4.0.0
 */
export function makeEffect<S extends Schema.Top>(schema: S) {
  const ast = recurDefaults(AST.toType(schema.ast))
  const parser = run<S["Type"], never>(ast)
  return (input: S["~type.make.in"], options?: Schema.MakeOptions): Effect.Effect<S["Type"], Issue.Issue> => {
    return parser(
      input,
      options?.disableChecks
        ? options?.parseOptions ? { ...options.parseOptions, disableChecks: true } : { disableChecks: true }
        : options?.parseOptions
    )
  }
}

/**
 * Creates a synchronous maker that returns `Option.some` with the constructed
 * value on success, or `Option.none` when construction fails.
 *
 * **When to use**
 *
 * Use this when you only need to know whether constructor input is valid and do
 * not need error details.
 *
 * @category Constructing
 * @since 4.0.0
 */
export function makeOption<S extends Schema.Top>(schema: S) {
  const parser = makeEffect(schema)
  return (input: S["~type.make.in"], options?: Schema.MakeOptions): Option.Option<S["Type"]> => {
    return Exit.getSuccess(Effect.runSyncExit(parser(input, options) as any))
  }
}

/**
 * Creates a synchronous maker for the schema's decoded type side.
 *
 * **Details**
 *
 * The returned function constructs a value from constructor input and throws an
 * `Error` with the `SchemaIssue.Issue` in its `cause` when construction fails.
 *
 * @category Constructing
 * @since 4.0.0
 */
export function make<S extends Schema.Top>(schema: S) {
  const parser = makeEffect(schema)
  return (input: S["~type.make.in"], options?: Schema.MakeOptions): S["Type"] => {
    return Effect.runSync(
      Effect.mapErrorEager(
        parser(input, options),
        (issue) => new Error(issue.toString(), { cause: issue })
      )
    )
  }
}

/**
 * Creates a type guard that checks whether an input satisfies the schema's decoded
 * type side.
 *
 * **Details**
 *
 * The guard returns `true` on successful validation and `false` on failure, without
 * exposing issue details.
 *
 * @category Asserting
 * @since 3.10.0
 */
export function is<T>(schema: Schema.Schema<T>): <I>(input: I) => input is I & T {
  return _is<T>(schema.ast)
}

/** @internal */
export function _is<T>(ast: AST.AST) {
  const parser = asExit(run<T, never>(AST.toType(ast)))
  return <I>(input: I): input is I & T => {
    return Exit.isSuccess(parser(input, AST.defaultParseOptions))
  }
}

/** @internal */
export function _issue<T>(ast: AST.AST) {
  const parser = run<T, never>(ast)
  return (input: unknown, options: AST.ParseOptions): Issue.Issue | undefined => {
    return Effect.runSync(Effect.matchEager(parser(input, options), {
      onSuccess: () => undefined,
      onFailure: identity
    }))
  }
}

/**
 * Asserts that an input satisfies the schema's decoded type side.
 *
 * **Details**
 *
 * The assertion returns normally when validation succeeds and throws when the
 * input does not satisfy the schema.
 *
 * @category Asserting
 * @since 4.0.0
 */
export function asserts<S extends Schema.Top, I>(schema: S, input: I): asserts input is I & S["Type"] {
  const parser = asExit(run<S["Type"], never>(AST.toType(schema.ast)))
  const exit = parser(input, AST.defaultParseOptions)
  if (Exit.isFailure(exit)) {
    const issue = Cause.findError(exit.cause)
    if (Result.isFailure(issue)) {
      throw Cause.squash(issue.failure)
    }
    throw new Error(issue.success.toString(), { cause: issue.success })
  }
}

/**
 * Creates an effectful decoder for `unknown` input.
 *
 * **Details**
 *
 * The returned function succeeds with the schema's decoded `Type` or fails with a
 * `SchemaIssue.Issue`. Decoding service requirements are preserved in the returned
 * `Effect`. Parse options may be provided when creating the decoder and overridden
 * when applying it.
 *
 * @category decoding
 * @since 4.0.0
 */
export function decodeUnknownEffect<S extends Schema.Top>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Effect.Effect<S["Type"], Issue.Issue, S["DecodingServices"]> {
  const parser = run<S["Type"], S["DecodingServices"]>(schema.ast)
  return options === undefined
    ? parser
    : (input, overrideOptions) => parser(input, mergeParseOptions(options, overrideOptions))
}

/**
 * Creates an effectful decoder for input already typed as the schema's `Encoded`
 * type.
 *
 * **Details**
 *
 * The returned function succeeds with the decoded `Type` or fails with a
 * `SchemaIssue.Issue`, preserving any decoding service requirements in the
 * returned `Effect`.
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeEffect: <S extends Schema.Top>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => Effect.Effect<S["Type"], Issue.Issue, S["DecodingServices"]> =
  decodeUnknownEffect

/**
 * Creates a Promise-based decoder for `unknown` input.
 *
 * **Details**
 *
 * The returned function resolves with the decoded `Type` on success and rejects
 * with a `SchemaIssue.Issue` on decoding failure.
 *
 * @category decoding
 * @since 3.10.0
 */
export function decodeUnknownPromise<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Promise<S["Type"]> {
  return asPromise(decodeUnknownEffect(schema, options))
}

/**
 * Creates a Promise-based decoder for input already typed as the schema's
 * `Encoded` type.
 *
 * **Details**
 *
 * The returned function resolves with the decoded `Type` on success and rejects
 * with a `SchemaIssue.Issue` on decoding failure.
 *
 * @category decoding
 * @since 3.10.0
 */
export function decodePromise<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: S["Encoded"], options?: AST.ParseOptions) => Promise<S["Type"]> {
  return asPromise(decodeEffect(schema, options))
}

/**
 * Creates a synchronous decoder for `unknown` input that returns an `Exit`.
 *
 * **Details**
 *
 * The returned function produces `Exit.Success` with the decoded `Type` or
 * `Exit.Failure` with a `SchemaIssue.Issue`.
 *
 * @category decoding
 * @since 4.0.0
 */
export function decodeUnknownExit<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Exit.Exit<S["Type"], Issue.Issue> {
  return asExit(decodeUnknownEffect(schema, options))
}

/**
 * Creates a synchronous decoder for input already typed as the schema's `Encoded`
 * type, returning an `Exit`.
 *
 * **Details**
 *
 * The returned function produces `Exit.Success` with the decoded `Type` or
 * `Exit.Failure` with a `SchemaIssue.Issue`.
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeExit: <S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => Exit.Exit<S["Type"], Issue.Issue> = decodeUnknownExit

/**
 * Creates a decoder for `unknown` input that returns an `Option`.
 *
 * **Details**
 *
 * The returned function produces `Option.some` with the decoded `Type` on success
 * or `Option.none` on failure, discarding issue details.
 *
 * @category decoding
 * @since 3.10.0
 */
export function decodeUnknownOption<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Option.Option<S["Type"]> {
  return asOption(decodeUnknownEffect(schema, options))
}

/**
 * Creates a decoder for input already typed as the schema's `Encoded` type,
 * returning an `Option`.
 *
 * **Details**
 *
 * The returned function produces `Option.some` with the decoded `Type` on success
 * or `Option.none` on failure, discarding issue details.
 *
 * @category decoding
 * @since 3.10.0
 */
export const decodeOption: <S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => Option.Option<S["Type"]> = decodeUnknownOption

/**
 * Creates a decoder for `unknown` input that returns a `Result`.
 *
 * **Details**
 *
 * The returned function produces `Result.succeed` with the decoded `Type` on
 * success or `Result.fail` with a `SchemaIssue.Issue` on decoding failure.
 *
 * @category decoding
 * @since 4.0.0
 */
export function decodeUnknownResult<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Result.Result<S["Type"], Issue.Issue> {
  return asResult(decodeUnknownEffect(schema, options))
}

/**
 * Creates a decoder for input already typed as the schema's `Encoded` type,
 * returning a `Result`.
 *
 * **Details**
 *
 * The returned function produces `Result.succeed` with the decoded `Type` on
 * success or `Result.fail` with a `SchemaIssue.Issue` on decoding failure.
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeResult: <S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => Result.Result<S["Type"], Issue.Issue> = decodeUnknownResult

/**
 * Creates a synchronous decoder for `unknown` input.
 *
 * **Details**
 *
 * The returned function returns the decoded `Type` on success and throws an
 * `Error` with the `SchemaIssue.Issue` in its `cause` on decoding failure.
 *
 * @category decoding
 * @since 3.10.0
 */
export function decodeUnknownSync<S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => S["Type"] {
  return asSync(decodeUnknownEffect(schema, options))
}

/**
 * Creates a synchronous decoder for input already typed as the schema's `Encoded`
 * type.
 *
 * **Details**
 *
 * The returned function returns the decoded `Type` on success and throws an
 * `Error` with the `SchemaIssue.Issue` in its `cause` on decoding failure.
 *
 * @category decoding
 * @since 3.10.0
 */
export const decodeSync: <S extends Schema.Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => S["Type"] = decodeUnknownSync

/**
 * Creates an effectful encoder for `unknown` input.
 *
 * **Details**
 *
 * The returned function succeeds with the schema's `Encoded` value or fails with a
 * `SchemaIssue.Issue`. Encoding service requirements are preserved in the returned
 * `Effect`. Parse options may be provided when creating the encoder and overridden
 * when applying it.
 *
 * @category encoding
 * @since 4.0.0
 */
export function encodeUnknownEffect<S extends Schema.Top>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Effect.Effect<S["Encoded"], Issue.Issue, S["EncodingServices"]> {
  const parser = run<S["Encoded"], S["EncodingServices"]>(AST.flip(schema.ast))
  return options === undefined
    ? parser
    : (input, overrideOptions) => parser(input, mergeParseOptions(options, overrideOptions))
}

/**
 * Creates an effectful encoder for input already typed as the schema's decoded
 * `Type`.
 *
 * **Details**
 *
 * The returned function succeeds with the schema's `Encoded` value or fails with a
 * `SchemaIssue.Issue`, preserving any encoding service requirements in the
 * returned `Effect`.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeEffect: <S extends Schema.Top>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Effect.Effect<S["Encoded"], Issue.Issue, S["EncodingServices"]> =
  encodeUnknownEffect

/**
 * Creates a Promise-based encoder for `unknown` input.
 *
 * **Details**
 *
 * The returned function resolves with the schema's `Encoded` value on success and
 * rejects with a `SchemaIssue.Issue` on encoding failure.
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodeUnknownPromise = <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Promise<S["Encoded"]> =>
  asPromise(encodeUnknownEffect(schema, options))

/**
 * Creates a Promise-based encoder for input already typed as the schema's decoded
 * `Type`.
 *
 * **Details**
 *
 * The returned function resolves with the schema's `Encoded` value on success and
 * rejects with a `SchemaIssue.Issue` on encoding failure.
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodePromise: <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Promise<S["Encoded"]> = encodeUnknownPromise

/**
 * Creates a synchronous encoder for `unknown` input that returns an `Exit`.
 *
 * **Details**
 *
 * The returned function produces `Exit.Success` with the schema's `Encoded` value
 * or `Exit.Failure` with a `SchemaIssue.Issue`.
 *
 * @category encoding
 * @since 4.0.0
 */
export function encodeUnknownExit<S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Exit.Exit<S["Encoded"], Issue.Issue> {
  return asExit(encodeUnknownEffect(schema, options))
}

/**
 * Creates a synchronous encoder for input already typed as the schema's decoded
 * `Type`, returning an `Exit`.
 *
 * **Details**
 *
 * The returned function produces `Exit.Success` with the schema's `Encoded` value
 * or `Exit.Failure` with a `SchemaIssue.Issue`.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeExit: <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Exit.Exit<S["Encoded"], Issue.Issue> = encodeUnknownExit

/**
 * Creates an encoder for `unknown` input that returns an `Option`.
 *
 * **Details**
 *
 * The returned function produces `Option.some` with the schema's `Encoded` value
 * on success or `Option.none` on failure, discarding issue details.
 *
 * @category encoding
 * @since 3.10.0
 */
export function encodeUnknownOption<S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Option.Option<S["Encoded"]> {
  return asOption(encodeUnknownEffect(schema, options))
}

/**
 * Creates an encoder for input already typed as the schema's decoded `Type`,
 * returning an `Option`.
 *
 * **Details**
 *
 * The returned function produces `Option.some` with the schema's `Encoded` value
 * on success or `Option.none` on failure, discarding issue details.
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodeOption: <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Option.Option<S["Encoded"]> = encodeUnknownOption

/**
 * Creates an encoder for `unknown` input that returns a `Result`.
 *
 * **Details**
 *
 * The returned function produces `Result.succeed` with the schema's `Encoded`
 * value on success or `Result.fail` with a `SchemaIssue.Issue` on encoding
 * failure.
 *
 * @category encoding
 * @since 4.0.0
 */
export function encodeUnknownResult<S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => Result.Result<S["Encoded"], Issue.Issue> {
  return asResult(encodeUnknownEffect(schema, options))
}

/**
 * Creates an encoder for input already typed as the schema's decoded `Type`,
 * returning a `Result`.
 *
 * **Details**
 *
 * The returned function produces `Result.succeed` with the schema's `Encoded`
 * value on success or `Result.fail` with a `SchemaIssue.Issue` on encoding
 * failure.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeResult: <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Result.Result<S["Encoded"], Issue.Issue> = encodeUnknownResult

/**
 * Creates a synchronous encoder for `unknown` input.
 *
 * **Details**
 *
 * The returned function returns the schema's `Encoded` value on success and throws
 * an `Error` with the `SchemaIssue.Issue` in its `cause` on encoding failure.
 *
 * @category encoding
 * @since 3.10.0
 */
export function encodeUnknownSync<S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
): (input: unknown, options?: AST.ParseOptions) => S["Encoded"] {
  return asSync(encodeUnknownEffect(schema, options))
}

/**
 * Creates a synchronous encoder for input already typed as the schema's decoded
 * `Type`.
 *
 * **Details**
 *
 * The returned function returns the schema's `Encoded` value on success and throws
 * an `Error` with the `SchemaIssue.Issue` in its `cause` on encoding failure.
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodeSync: <S extends Schema.Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => S["Encoded"] = encodeUnknownSync

const mergeParseOptions = (
  options: AST.ParseOptions,
  overrideOptions: AST.ParseOptions | undefined
): AST.ParseOptions => overrideOptions === undefined ? options : { ...options, ...overrideOptions }

/** @internal */
export function run<T, R>(ast: AST.AST) {
  const parser = recur(ast)
  return (input: unknown, options?: AST.ParseOptions): Effect.Effect<T, Issue.Issue, R> =>
    Effect.flatMapEager(parser(Option.some(input), options ?? AST.defaultParseOptions), (oa) => {
      if (oa._tag === "None") {
        return Effect.fail(new Issue.InvalidValue(oa))
      }
      return Effect.succeed(oa.value as T)
    })
}

function asPromise<T, E>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue>
): (input: E, options?: AST.ParseOptions) => Promise<T> {
  return (input: E, options?: AST.ParseOptions) => Effect.runPromise(parser(input, options))
}

function asExit<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => Exit.Exit<T, Issue.Issue> {
  return (input: E, options?: AST.ParseOptions) => Effect.runSyncExit(parser(input, options) as any)
}

/** @internal */
export function asOption<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => Option.Option<T> {
  const parserExit = asExit(parser)
  return (input: E, options?: AST.ParseOptions) => Exit.getSuccess(parserExit(input, options))
}

function asResult<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => Result.Result<T, Issue.Issue> {
  const parserExit = asExit(parser)
  return (input: E, options?: AST.ParseOptions) => {
    const exit = parserExit(input, options)
    if (Exit.isSuccess(exit)) {
      return Result.succeed(exit.value)
    }
    const error = Cause.findError(exit.cause)
    if (Result.isFailure(error)) {
      throw Cause.squash(error.failure)
    }
    return Result.fail(error.success)
  }
}

function asSync<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => T {
  return (input: E, options?: AST.ParseOptions) =>
    Effect.runSync(
      Effect.mapErrorEager(
        parser(input, options),
        (issue) => new Error(issue.toString(), { cause: issue })
      ) as any
    )
}

/** @internal */
export interface Parser {
  (input: Option.Option<unknown>, options: AST.ParseOptions): Effect.Effect<Option.Option<unknown>, Issue.Issue, any>
}

const recur = memoize(
  (ast: AST.AST): Parser => {
    let parser: Parser
    const astOptions = InternalAnnotations.resolve(ast)?.["parseOptions"]
    if (!ast.context && !ast.encoding && !ast.checks) {
      return (ou, options) => {
        parser ??= ast.getParser(recur)
        if (astOptions) {
          options = { ...options, ...astOptions }
        }
        return parser(ou, options)
      }
    }
    const isStructural = AST.isArrays(ast) || AST.isObjects(ast) ||
      (AST.isDeclaration(ast) && ast.typeParameters.length > 0)
    return (ou, options) => {
      if (astOptions) {
        options = { ...options, ...astOptions }
      }
      const encoding = ast.encoding
      let srou: Effect.Effect<Option.Option<unknown>, Issue.Issue, unknown> | undefined
      if (encoding) {
        const links = encoding
        const len = links.length
        for (let i = len - 1; i >= 0; i--) {
          const link = links[i]
          const to = link.to
          const parser = recur(to)
          srou = srou ? Effect.flatMapEager(srou, (ou) => parser(ou, options)) : parser(ou, options)
          if (link.transformation._tag === "Transformation") {
            const getter = link.transformation.decode
            srou = Effect.flatMapEager(srou, (ou) => getter.run(ou, options))
          } else {
            srou = link.transformation.decode(srou, options)
          }
        }
        srou = Effect.mapErrorEager(srou!, (issue) => new Issue.Encoding(ast, ou, issue))
      }

      parser ??= ast.getParser(recur)
      let sroa = srou ? Effect.flatMapEager(srou, (ou) => parser(ou, options)) : parser(ou, options)

      if (ast.checks && !options?.disableChecks) {
        const checks = ast.checks
        if (options?.errors === "all" && isStructural && Option.isSome(ou)) {
          sroa = Effect.catchEager(sroa, (issue) => {
            const issues: Array<Issue.Issue> = []
            AST.collectIssues(
              checks.filter((check) => check.annotations?.[AST.STRUCTURAL_ANNOTATION_KEY]),
              ou.value,
              issues,
              ast,
              options
            )
            const out: Issue.Issue = Arr.isArrayNonEmpty(issues)
              ? issue._tag === "Composite" && issue.ast === ast
                ? new Issue.Composite(ast, issue.actual, [...issue.issues, ...issues])
                : new Issue.Composite(ast, ou, [issue, ...issues])
              : issue
            return Effect.fail(out)
          })
        }
        sroa = Effect.flatMapEager(sroa, (oa) => {
          if (Option.isSome(oa)) {
            const value = oa.value
            const issues: Array<Issue.Issue> = []

            AST.collectIssues(checks, value, issues, ast, options)

            if (Arr.isArrayNonEmpty(issues)) {
              return Effect.fail(new Issue.Composite(ast, oa, issues))
            }
          }
          return Effect.succeed(oa)
        })
      }

      return sroa
    }
  }
)
