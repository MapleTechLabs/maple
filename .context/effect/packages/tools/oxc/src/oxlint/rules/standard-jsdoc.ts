/*
AI prompt for writing Effect public API JSDoc:

Prescription for LLMs editing this file: whenever you change the standard-jsdoc rule, parser, diagnostics, accepted tags, required tags, supported constructs, ignored constructs, examples, or spacing rules, update this prompt and `.agents/skills/standard-jsdoc/SKILL.md` in the same change so they remain aligned and this prompt remains the source of truth for writing valid JSDoc.

Write or update the JSDoc so it follows this exact structure. Use sober, practical prose. Do not use jargon when a plain word works. Do not be clever. Do not add filler sections.

Required shape:

Short description as one paragraph.

**When to use**

Optional practical usage guidance. Include this section only when it helps the reader decide whether to use the API.

**Details**

Optional details for complex APIs, options, overloads, or behavior that needs more than the short description.

**Gotchas**

Optional edge cases, footguns, or surprising behavior.

**Example** (Short title)

Optional prose explaining the example.

```ts
const result = example()
```

@deprecated Optional replacement guidance.
@default Optional member default value. Members only.
@see Optional related API or text. May include {@link Symbol}.
@category Required for root declarations; optional for namespaces and declarations inside namespaces.
@since Required for root declarations, namespaces, and namespace declarations. Use stable semver like 1.2.3.

Rules:

- Use a normal multiline JSDoc comment in source code, with leading `*` on each line as TypeScript expects.
- The short description is required and must be exactly one paragraph.
- The standard sections are optional, but if present they must appear in this order: When to use, Details, Gotchas.
- A present section must have a non-empty body.
- Use exactly one blank line between the short description, sections, examples, and tags.
- Examples must use `**Example** (Title)`, optional prose, and exactly one non-empty `ts` code fence.
- Do not use `@example`; examples are Markdown sections, not tags.
- Do not put TypeScript code fences outside example sections.
- Root declarations require `@category` and `@since`.
- Namespace docs and declarations inside namespaces require `@since` and may use `@category`.
- Member JSDoc is optional. When present, members do not require `@since`, may use `@default`, and must not use `@category`.
- `@internal` means the item is ignored; do not validate or rewrite it as public docs.
- Do not document module-level comments; this rule ignores module JSDoc.
- Default exports are ignored by this rule and do not need JSDoc.
- Do not add unsupported constructs such as enums or empty exports in checked files.

When updating existing JSDoc:

1. Keep correct facts and examples, but rewrite the layout into the standard template.
2. Move any usage guidance into `**When to use**`.
3. Move option/overload/behavior details into `**Details**`.
4. Move caveats into `**Gotchas**`.
5. Convert `@example` tags or loose `ts` fences into `**Example** (Title)` sections.
6. Preserve `@see`, `@deprecated`, `@default`, `@category`, and `@since` when valid for the documented item.
7. Remove sections that would be empty.
*/

import * as fs from "node:fs"
import * as path from "node:path"
import type { CreateRule, ESTree, Visitor } from "oxlint"
import * as ts from "typescript"

interface RuleOptions {
  readonly include?: Array<string>
  readonly exclude?: Array<string>
  readonly tsconfig?: string
}

type ExportBucket = "value" | "type"
type DocScope = "declaration" | "namespace" | "namespace-declaration" | "member"

type Result<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E }

/**
 * Result type returned by the standard JSDoc parser helpers.
 *
 * @category utility types
 * @since 4.0.0
 */
export type StandardJSDocResult<A, E> = Result<A, E>

/**
 * Diagnostic emitted when a JSDoc block does not follow the standard shape.
 *
 * @category models
 * @since 4.0.0
 */
export interface StandardJSDocDiagnostic {
  readonly code: string
  readonly message: string
}

/**
 * Parse error containing all diagnostics collected for a JSDoc block or file.
 *
 * @category models
 * @since 4.0.0
 */
export interface StandardJSDocParseError {
  readonly diagnostics: ReadonlyArray<StandardJSDocDiagnostic>
}

/**
 * Parsed `@see` tag text and any inline links it contains.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedSeeTag {
  readonly text: string
  readonly links: ReadonlyArray<ParsedInlineLink>
}

/**
 * Parsed inline JSDoc link target and optional display text.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedInlineLink {
  readonly raw: string
  readonly target: string
  readonly text: string | null
}

/**
 * Parsed standard JSDoc description sections.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedDescription {
  readonly short: string
  readonly whenToUse: string | null
  readonly details: string | null
  readonly gotchas: string | null
}

/**
 * Parsed example section from a standard JSDoc block.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedExample {
  readonly title: string
  readonly body: string | null
  readonly code: string
}

/**
 * Parsed tags required for a root public declaration.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedDeclarationTags {
  readonly category: string
  readonly since: string
  readonly deprecated: string | null
  readonly see: ReadonlyArray<ParsedSeeTag>
}

/**
 * Parsed tags allowed for namespace JSDoc.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedNamespaceTags {
  readonly category: string | null
  readonly since: string
  readonly deprecated: string | null
  readonly see: ReadonlyArray<ParsedSeeTag>
}

/**
 * Parsed tags allowed for documented members.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedMemberTags {
  readonly since: string | null
  readonly default: string | null
  readonly deprecated: string | null
  readonly see: ReadonlyArray<ParsedSeeTag>
}

/**
 * Parsed documented member within a declaration or another member.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedMember {
  readonly name: string
  readonly description: ParsedDescription
  readonly examples: ReadonlyArray<ParsedExample>
  readonly tags: ParsedMemberTags
  readonly members: ReadonlyArray<ParsedMember>
}

/**
 * Parsed root declaration exported from a checked file.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedRootDeclaration {
  readonly name: string
  readonly bucket: ExportBucket
  readonly description: ParsedDescription
  readonly examples: ReadonlyArray<ParsedExample>
  readonly tags: ParsedDeclarationTags
  readonly members: ReadonlyArray<ParsedMember>
}

/**
 * Parsed type declaration exported from inside a namespace.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedNamespaceDeclaration {
  readonly name: string
  readonly description: ParsedDescription
  readonly examples: ReadonlyArray<ParsedExample>
  readonly tags: ParsedNamespaceTags
  readonly members: ReadonlyArray<ParsedMember>
}

/**
 * Parsed namespace and its documented exported type declarations.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedNamespace {
  readonly name: string
  readonly description: ParsedDescription
  readonly examples: ReadonlyArray<ParsedExample>
  readonly tags: ParsedNamespaceTags
  readonly declarations: ReadonlyArray<ParsedNamespaceDeclaration>
  readonly namespaces: ReadonlyArray<ParsedNamespace>
}

/**
 * Parsed public JSDoc data collected from one checked file.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedStandardJSDocFile {
  readonly declarations: ReadonlyArray<ParsedRootDeclaration>
  readonly namespaces: ReadonlyArray<ParsedNamespace>
}

/**
 * Barrel import metadata for a public module included in the standard JSDoc dump.
 *
 * @category models
 * @since 4.0.0
 */
export type ParsedStandardJSDocBarrelImport =
  | {
    readonly type: "namespace"
    readonly module: string
    readonly name: string
  }
  | {
    readonly type: "flat"
    readonly module: string
  }

/**
 * Import specifiers for a public module included in the standard JSDoc dump.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedStandardJSDocImports {
  readonly module: string
  readonly barrel: ParsedStandardJSDocBarrelImport | null
}

interface ParsedBarrelExports {
  readonly namespace: ReadonlyMap<string, string>
  readonly flat: ReadonlySet<string>
}

/**
 * Parsed public JSDoc data paired with the normalized source file path.
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedStandardJSDocFileDumpEntry extends ParsedStandardJSDocFile {
  readonly file: string
  readonly imports: ParsedStandardJSDocImports
}

interface AstNode {
  readonly type: string
  readonly range: [number, number]
  readonly [key: string]: any
}

interface JSDocTag {
  readonly name: string
  value: string
  readonly line: number
}

interface JSDocBlock {
  readonly range: [number, number]
  readonly raw: string
  readonly lines: Array<string>
  readonly tags: Array<JSDocTag>
  readonly parsed?: ParsedCoreJSDoc
  readonly diagnostics: Array<StandardJSDocDiagnostic>
  readonly internal: boolean
}

interface ParsedCoreJSDoc {
  readonly description: ParsedDescription
  readonly examples: ReadonlyArray<ParsedExample>
  readonly tags: ReadonlyArray<JSDocTag>
}

interface ProgramCacheEntry {
  readonly program?: ts.Program
  readonly modulesByName?: ReadonlyMap<string, ts.Symbol>
  readonly error?: string
  reported: boolean
}

interface PackageMetadata {
  readonly root: string
  readonly sourceRoot: string
  readonly name: string
  readonly exports: unknown
}

interface PackageExportMatch {
  readonly key: string
  readonly value: unknown
  readonly star: string | null
  readonly specificity: number
  readonly prefixLength: number
}

interface ParsedConfigResult {
  readonly parsed?: ts.ParsedCommandLine
  readonly error?: string
}

const programCache = new Map<string, ProgramCacheEntry>()
const packageMetadataCache = new Map<string, Result<PackageMetadata, string>>()
const barrelExportCache = new Map<string, Result<ParsedBarrelExports, string>>()
const dumpStateKey = Symbol.for("@effect/oxc/standard-jsdoc/dump-state")

interface StandardJSDocDumpState {
  readonly entries: Array<ParsedStandardJSDocFileDumpEntry>
  registered: boolean
  cwd: string
  errorCount: number
}

function getDumpState(cwd: string): StandardJSDocDumpState {
  const normalizedCwd = path.resolve(cwd)
  const global = globalThis as typeof globalThis & { [dumpStateKey]?: Map<string, StandardJSDocDumpState> }
  if (global[dumpStateKey] === undefined) {
    global[dumpStateKey] = new Map()
  }
  let state = global[dumpStateKey].get(normalizedCwd)
  if (state === undefined) {
    state = { entries: [], registered: false, cwd: normalizedCwd, errorCount: 0 }
    global[dumpStateKey].set(normalizedCwd, state)
  }
  return state
}

function recordDumpError(cwd: string) {
  getDumpState(cwd).errorCount++
}

function registerDump(cwd: string, entry: ParsedStandardJSDocFileDumpEntry) {
  const state = getDumpState(cwd)
  state.entries.push(entry)
  if (state.registered) {
    return
  }
  state.registered = true
  state.cwd = path.resolve(cwd)
  process.once("exit", () => {
    if (state.errorCount > 0) {
      return
    }
    const dataDirectory = path.join(state.cwd, ".data")
    const files = [...state.entries].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    fs.mkdirSync(dataDirectory, { recursive: true })
    fs.writeFileSync(
      path.join(dataDirectory, "standard-jsdoc.json"),
      `${JSON.stringify({ files }, null, 2)}\n`
    )
  })
}

const tagOrder = new Map([
  ["deprecated", 0],
  ["default", 1],
  ["see", 2],
  ["category", 3],
  ["since", 4]
])

const stableSemverRegex = /^\d+\.\d+\.\d+$/
const urlRegex = /^https?:\/\//

function diagnostic(code: string, message: string): StandardJSDocDiagnostic {
  return { code, message }
}

function normalizePathName(filePath: string): string {
  return filePath.replaceAll(path.sep, "/")
}

function normalizePackagePath(filePath: string): string {
  return normalizePathName(filePath).replace(/^\.\//, "./")
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
}

function globToRegExp(glob: string): RegExp {
  let source = "^"
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    const next = glob[index + 1]
    if (char === "*") {
      if (next === "*") {
        source += ".*"
        index++
      } else {
        source += "[^/]*"
      }
    } else if (char === "?") {
      source += "[^/]"
    } else {
      source += escapeRegExp(char)
    }
  }
  return new RegExp(`${source}$`)
}

/**
 * Creates a predicate that checks whether a filename is included by the configured standard JSDoc globs.
 *
 * @category constructors
 * @since 4.0.0
 */
export function createStandardJSDocFileMatcher(options: {
  readonly cwd: string
  readonly include?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
}): (filename: string) => boolean {
  const include = options.include?.map(globToRegExp)
  const exclude = options.exclude?.map(globToRegExp)
  return (filename) => {
    const normalizedFilename = normalizePathName(filename)
    const relativeFilename = normalizePathName(path.relative(options.cwd, filename))
    const matches = (regexp: RegExp) => regexp.test(normalizedFilename) || regexp.test(relativeFilename)
    if (include !== undefined && !include.some(matches)) {
      return false
    }
    if (exclude !== undefined && exclude.some(matches)) {
      return false
    }
    return true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function findPackageRoot(filename: string): string | undefined {
  let directory = path.dirname(path.resolve(filename))
  while (true) {
    const packageJsonPath = path.join(directory, "package.json")
    if (fs.existsSync(packageJsonPath)) {
      return directory
    }
    const parent = path.dirname(directory)
    if (parent === directory) {
      return undefined
    }
    directory = parent
  }
}

function readPackageMetadata(root: string): Result<PackageMetadata, string> {
  const normalizedRoot = path.resolve(root)
  const cached = packageMetadataCache.get(normalizedRoot)
  if (cached !== undefined) {
    return cached
  }
  const packageJsonPath = path.join(normalizedRoot, "package.json")
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
  } catch (error) {
    const result = {
      _tag: "Failure",
      error: `unable to read package.json at ${packageJsonPath}: ${String(error)}`
    } as const
    packageMetadataCache.set(normalizedRoot, result)
    return result
  }
  if (!isRecord(parsed)) {
    const result = { _tag: "Failure", error: `package.json at ${packageJsonPath} must be an object` } as const
    packageMetadataCache.set(normalizedRoot, result)
    return result
  }
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    const result = {
      _tag: "Failure",
      error: `package.json at ${packageJsonPath} must include a non-empty name`
    } as const
    packageMetadataCache.set(normalizedRoot, result)
    return result
  }
  if (parsed.exports === undefined) {
    const result = { _tag: "Failure", error: `package.json at ${packageJsonPath} must include exports` } as const
    packageMetadataCache.set(normalizedRoot, result)
    return result
  }
  const result = {
    _tag: "Success",
    value: {
      root: normalizedRoot,
      sourceRoot: path.join(normalizedRoot, "src"),
      name: parsed.name,
      exports: parsed.exports
    }
  } as const
  packageMetadataCache.set(normalizedRoot, result)
  return result
}

function parseBarrelExports(indexPath: string): Result<ParsedBarrelExports, string> {
  const normalizedIndexPath = path.resolve(indexPath)
  const cached = barrelExportCache.get(normalizedIndexPath)
  if (cached !== undefined) {
    return cached
  }
  let source: string
  try {
    source = fs.readFileSync(normalizedIndexPath, "utf8")
  } catch (error) {
    const result = {
      _tag: "Failure",
      error: `unable to read barrel file ${normalizedIndexPath}: ${String(error)}`
    } as const
    barrelExportCache.set(normalizedIndexPath, result)
    return result
  }
  const sourceFile = ts.createSourceFile(normalizedIndexPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const namespace = new Map<string, string>()
  const flat = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const moduleSpecifier = normalizePathName(statement.moduleSpecifier.text)
      if (statement.exportClause === undefined) {
        flat.add(moduleSpecifier)
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        namespace.set(moduleSpecifier, statement.exportClause.name.text)
      }
    }
  }
  const result = { _tag: "Success", value: { namespace, flat } } as const
  barrelExportCache.set(normalizedIndexPath, result)
  return result
}

function getPackageExportMatch(exports: unknown, subpath: string): PackageExportMatch | undefined {
  if (!isRecord(exports)) {
    return subpath === "." ? { key: ".", value: exports, star: null, specificity: 1, prefixLength: 1 } : undefined
  }
  if (Object.hasOwn(exports, subpath)) {
    return {
      key: subpath,
      value: exports[subpath],
      star: null,
      specificity: Number.MAX_SAFE_INTEGER,
      prefixLength: subpath.length
    }
  }
  const matches: Array<PackageExportMatch> = []
  for (const [key, value] of Object.entries(exports)) {
    const starIndex = key.indexOf("*")
    if (!key.startsWith(".") || starIndex === -1) {
      continue
    }
    const prefix = key.slice(0, starIndex)
    const suffix = key.slice(starIndex + 1)
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) {
      continue
    }
    matches.push({
      key,
      value,
      star: subpath.slice(prefix.length, subpath.length - suffix.length),
      specificity: prefix.length + suffix.length,
      prefixLength: prefix.length
    })
  }
  return matches.sort((a, b) =>
    b.specificity - a.specificity || b.prefixLength - a.prefixLength || b.key.length - a.key.length
  )[0]
}

function packageExportTargetMatches(value: unknown, star: string | null, expectedTarget: string): boolean {
  if (typeof value === "string") {
    const target = normalizePackagePath(star === null ? value : value.replaceAll("*", star))
    return target === expectedTarget
  }
  if (value === null || value === undefined) {
    return false
  }
  if (Array.isArray(value)) {
    return value.some((item) => packageExportTargetMatches(item, star, expectedTarget))
  }
  if (isRecord(value)) {
    return Object.values(value).some((item) => packageExportTargetMatches(item, star, expectedTarget))
  }
  return false
}

function isPackageSubpathExported(
  packageExports: unknown,
  subpath: string,
  expectedTarget: string
): boolean {
  const match = getPackageExportMatch(packageExports, subpath)
  return match !== undefined && packageExportTargetMatches(match.value, match.star, expectedTarget)
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function packageSpecifier(packageName: string, subpath: string): string {
  return subpath === "" ? packageName : `${packageName}/${subpath}`
}

function resolveBarrelImport(
  metadata: PackageMetadata,
  filename: string
): Result<ParsedStandardJSDocBarrelImport | null, string> {
  let directory = path.dirname(filename)
  while (isPathInside(metadata.sourceRoot, directory)) {
    const indexPath = path.join(directory, "index.ts")
    if (indexPath !== filename && fs.existsSync(indexPath)) {
      const expectedExport = `./${normalizePathName(path.relative(directory, filename))}`
      const parsed = parseBarrelExports(indexPath)
      if (parsed._tag === "Failure") {
        return parsed
      }
      const barrelSubpath = normalizePathName(path.relative(metadata.sourceRoot, directory))
      const exportSubpath = barrelSubpath === "" ? "." : `./${barrelSubpath}`
      const exportTarget = barrelSubpath === "" ? "./src/index.ts" : `./src/${barrelSubpath}/index.ts`
      if (isPackageSubpathExported(metadata.exports, exportSubpath, exportTarget)) {
        const moduleSpecifier = packageSpecifier(metadata.name, barrelSubpath)
        const namespace = parsed.value.namespace.get(expectedExport)
        if (namespace !== undefined) {
          return {
            _tag: "Success",
            value: { type: "namespace", module: moduleSpecifier, name: namespace }
          }
        }
        if (parsed.value.flat.has(expectedExport)) {
          return {
            _tag: "Success",
            value: { type: "flat", module: moduleSpecifier }
          }
        }
      }
    }
    if (directory === metadata.sourceRoot) {
      break
    }
    directory = path.dirname(directory)
  }
  return { _tag: "Success", value: null }
}

function resolveStandardJSDocImports(
  cwd: string,
  filename: string
): Result<ParsedStandardJSDocImports, string> {
  const absoluteFilename = path.resolve(filename)
  const packageRoot = findPackageRoot(absoluteFilename)
  const relativeFilename = normalizePathName(path.relative(cwd, absoluteFilename))
  if (packageRoot === undefined) {
    return { _tag: "Failure", error: `no package.json found for ${relativeFilename}` }
  }
  const metadata = readPackageMetadata(packageRoot)
  if (metadata._tag === "Failure") {
    return metadata
  }
  const relativeToSourceRoot = normalizePathName(path.relative(metadata.value.sourceRoot, absoluteFilename))
  if (!isPathInside(metadata.value.sourceRoot, absoluteFilename)) {
    return {
      _tag: "Failure",
      error: `${relativeFilename} is not under ${normalizePathName(path.relative(cwd, metadata.value.sourceRoot))}`
    }
  }
  if (path.basename(absoluteFilename) === "index.ts") {
    return {
      _tag: "Failure",
      error: `${relativeFilename} is a barrel file; exclude it from standard-jsdoc`
    }
  }
  if (path.extname(absoluteFilename) !== ".ts" || absoluteFilename.endsWith(".d.ts")) {
    return {
      _tag: "Failure",
      error: `${relativeFilename} is not a TypeScript source module`
    }
  }
  const moduleSubpath = relativeToSourceRoot.slice(0, -".ts".length)
  const moduleExportSubpath = `./${moduleSubpath}`
  const moduleExportTarget = `./src/${relativeToSourceRoot}`
  if (!isPackageSubpathExported(metadata.value.exports, moduleExportSubpath, moduleExportTarget)) {
    return {
      _tag: "Failure",
      error: `package.json exports do not expose ${
        packageSpecifier(metadata.value.name, moduleSubpath)
      } for ${relativeFilename}`
    }
  }
  const barrel = resolveBarrelImport(metadata.value, absoluteFilename)
  if (barrel._tag === "Failure") {
    return barrel
  }
  return {
    _tag: "Success",
    value: {
      module: packageSpecifier(metadata.value.name, moduleSubpath),
      barrel: barrel.value
    }
  }
}

function getSourceText(context: {
  readonly sourceCode: { readonly text?: string; getText(node?: unknown): string }
}): string {
  return context.sourceCode.text ?? context.sourceCode.getText()
}

function getCwd(context: { readonly cwd?: string; getCwd?: () => string }): string {
  return context.cwd ?? context.getCwd?.() ?? process.cwd()
}

function skipWhitespace(source: string, end: number): number {
  while (end > 0 && /\s/.test(source[end - 1])) {
    end--
  }
  return end
}

function isSkippableDirectiveComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith("// @ts-expect-error") ||
    trimmed.startsWith("// @ts-ignore") ||
    trimmed.startsWith("// @effect-diagnostics") ||
    trimmed.startsWith("// eslint-disable-next-line") ||
    trimmed.startsWith("// oxlint-disable-next-line")
}

function skipDirectiveComments(source: string, end: number): number {
  while (end > 0) {
    const lineStart = source.lastIndexOf("\n", end - 1) + 1
    if (!isSkippableDirectiveComment(source.slice(lineStart, end))) {
      return end
    }
    end = skipWhitespace(source, lineStart)
  }
  return end
}

function findLeadingJSDoc(source: string, node: AstNode, ignoredRange?: [number, number]): JSDocBlock | undefined {
  const end = skipDirectiveComments(source, skipWhitespace(source, node.range[0]))
  if (!source.slice(0, end).endsWith("*/")) {
    return undefined
  }

  const start = source.lastIndexOf("/*", end)
  if (start === -1 || source[start + 2] !== "*") {
    return undefined
  }
  const range: [number, number] = [start, end]
  if (ignoredRange !== undefined && range[0] === ignoredRange[0] && range[1] === ignoredRange[1]) {
    return undefined
  }
  return parseJSDocBlock(source.slice(start, end), range)
}

/**
 * Parses one raw JSDoc block into the standard description, example, and tag structure.
 *
 * **Details**
 *
 * The block must have one short description paragraph, optional `When to use`, `Details`, and `Gotchas` sections in that order, then any example sections before tags. Example titles must be unique after trimming and lowercasing, each example must contain exactly one non-empty TypeScript code fence, and boundaries between sections, examples, and tags must use exactly one blank line.
 *
 * **Example** (Parsing a block)
 *
 * ```ts
 * const rawBlock = [
 *   "/" + "**",
 *   " * A value.",
 *   " *",
 *   " * @category models",
 *   " * @since 4.0.0",
 *   " *" + "/"
 * ].join("\n")
 * const result = parseStandardJSDoc(rawBlock)
 * ```
 *
 * @category parsing
 * @since 4.0.0
 */
export function parseStandardJSDoc(raw: string): Result<ParsedCoreJSDoc, StandardJSDocParseError> {
  const block = parseJSDocBlock(raw, [0, raw.length])
  if (block.internal) {
    return { _tag: "Failure", error: { diagnostics: [diagnostic("internal", "Internal JSDoc blocks are ignored")] } }
  }
  if (block.diagnostics.length > 0 || block.parsed === undefined) {
    return { _tag: "Failure", error: { diagnostics: block.diagnostics } }
  }
  return { _tag: "Success", value: block.parsed }
}

function parseJSDocBlock(raw: string, range: [number, number]): JSDocBlock {
  const body = raw.replace(/^\/\*\*/, "").replace(/\*\/$/, "")
  const rawLines = body.split(/\r\n|\r|\n/)
  const lines = rawLines.map((line) => line.replace(/^\s*\* ?/, "").trimEnd())
  const normalized = trimStructuralBlankLines(lines)
  const tags = parseTags(normalized)
  const internal = tags.some((tag) => tag.name === "internal")
  if (internal) {
    return { range, raw, lines: normalized, tags, diagnostics: [], internal }
  }
  const result = parseCoreJSDoc(normalized, tags)
  const block: JSDocBlock = {
    range,
    raw,
    lines: normalized,
    tags,
    diagnostics: result._tag === "Failure" ? Array.from(result.error.diagnostics) : [],
    internal
  }
  return result._tag === "Success" ? { ...block, parsed: result.value } : block
}

function trimStructuralBlankLines(lines: Array<string>): Array<string> {
  let start = 0
  let end = lines.length
  if (lines[start]?.trim() === "") {
    start++
  }
  if (end > start && lines[end - 1]?.trim() === "") {
    end--
  }
  return lines.slice(start, end)
}

function parseTags(lines: Array<string>): Array<JSDocTag> {
  const tags: Array<JSDocTag> = []
  let current: JSDocTag | undefined
  let inFence = false

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim()
    if (trimmed.startsWith("```")) {
      inFence = !inFence
      current = undefined
      continue
    }
    if (inFence) {
      continue
    }

    const match = /^@([A-Za-z][\w-]*)(?:\s+(.*))?$/.exec(trimmed)
    if (match) {
      current = { name: match[1], value: match[2]?.trim() ?? "", line: index }
      tags.push(current)
      continue
    }

    if (current !== undefined && trimmed !== "") {
      current.value = current.value === "" ? trimmed : `${current.value}\n${trimmed}`
    } else if (trimmed === "") {
      current = undefined
    }
  }

  return tags
}

function parseCoreJSDoc(lines: Array<string>, tags: Array<JSDocTag>): Result<ParsedCoreJSDoc, StandardJSDocParseError> {
  const diagnostics: Array<StandardJSDocDiagnostic> = []
  const firstTagLine = tags[0]?.line ?? lines.length
  const content = lines.slice(0, firstTagLine)

  if (lines.length === 0) {
    diagnostics.push(diagnostic("missing-description", "JSDoc must include a short description"))
  }
  if (content.at(-1)?.trim() === "" && tags.length > 0) {
    // exactly one blank before tags is validated by ensuring the last content line is blank and the previous is not blank
    if (content.length < 2 || content[content.length - 2]?.trim() === "") {
      diagnostics.push(
        diagnostic("invalid-spacing", "JSDoc tags must be separated from description content by exactly one blank line")
      )
    }
  } else if (tags.length > 0 && content.length > 0) {
    diagnostics.push(
      diagnostic("invalid-spacing", "JSDoc tags must be separated from description content by exactly one blank line")
    )
  }

  if (content[0]?.trim() === "") {
    diagnostics.push(diagnostic("leading-blank", "JSDoc must not start with a blank line"))
  }
  const contentWithoutTagBlank = tags.length > 0 && content.at(-1)?.trim() === "" ? content.slice(0, -1) : content
  if (contentWithoutTagBlank.at(-1)?.trim() === "") {
    diagnostics.push(diagnostic("trailing-blank", "JSDoc description must not end with a blank line"))
  }

  const parsedContent = parseDescriptionContent(contentWithoutTagBlank)
  diagnostics.push(...parsedContent.diagnostics)

  if (diagnostics.length > 0 || parsedContent.value === undefined) {
    return { _tag: "Failure", error: { diagnostics: uniqueDiagnostics(diagnostics) } }
  }
  return {
    _tag: "Success",
    value: {
      description: parsedContent.value.description,
      examples: parsedContent.value.examples,
      tags
    }
  }
}

function uniqueDiagnostics(
  diagnostics: ReadonlyArray<StandardJSDocDiagnostic>
): ReadonlyArray<StandardJSDocDiagnostic> {
  const seen = new Set<string>()
  return diagnostics.filter((item) => {
    const key = `${item.code}:${item.message}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const standardHeadings = ["**When to use**", "**Details**", "**Gotchas**"] as const

type StandardHeading = typeof standardHeadings[number]

interface ParsedContentResult {
  readonly value?: {
    readonly description: ParsedDescription
    readonly examples: ReadonlyArray<ParsedExample>
  }
  readonly diagnostics: ReadonlyArray<StandardJSDocDiagnostic>
}

function parseDescriptionContent(lines: Array<string>): ParsedContentResult {
  const diagnostics: Array<StandardJSDocDiagnostic> = []
  const sections: Record<StandardHeading, string | null> = {
    "**When to use**": null,
    "**Details**": null,
    "**Gotchas**": null
  }
  const examples: Array<ParsedExample> = []
  const exampleTitles = new Set<string>()
  let index = 0
  let currentSectionOrder = -1
  let examplesStarted = false

  while (index < lines.length && lines[index].trim() !== "" && !isHeadingLine(lines[index])) {
    if (isForbiddenMarkdownHeading(lines[index], false)) {
      diagnostics.push(diagnostic("invalid-heading", "Markdown headings are not allowed in JSDoc descriptions"))
    }
    index++
  }

  const shortLines = lines.slice(0, index)
  if (shortLines.length === 0 || joinBody(shortLines).trim() === "") {
    diagnostics.push(diagnostic("missing-description", "JSDoc must include a short description"))
  }
  if (index < lines.length && lines[index].trim() === "") {
    const next = lines[index + 1]
    if (next !== undefined && !isHeadingLine(next)) {
      diagnostics.push(diagnostic("multiple-description-paragraphs", "JSDoc short description must be one paragraph"))
    }
  }

  while (index < lines.length) {
    if (lines[index].trim() !== "") {
      diagnostics.push(diagnostic("invalid-spacing", "JSDoc sections must be separated by exactly one blank line"))
      break
    }
    if (lines[index + 1]?.trim() === "") {
      diagnostics.push(diagnostic("invalid-spacing", "JSDoc sections must be separated by exactly one blank line"))
      while (lines[index + 1]?.trim() === "") index++
    }
    index++
    if (index >= lines.length) {
      break
    }

    const line = lines[index].trim()
    if (line.startsWith("**Example**")) {
      examplesStarted = true
      const parsed = parseExample(lines, index)
      diagnostics.push(...parsed.diagnostics)
      if (parsed.example !== undefined) {
        const key = parsed.example.title.trim().toLowerCase()
        if (exampleTitles.has(key)) {
          diagnostics.push(diagnostic("duplicate-example", `Duplicate example title: ${parsed.example.title.trim()}`))
        }
        exampleTitles.add(key)
        examples.push(parsed.example)
      }
      index = parsed.nextIndex
      continue
    }

    const heading = standardHeadings.find((candidate) => candidate === line)
    if (heading !== undefined) {
      if (examplesStarted) {
        diagnostics.push(diagnostic("section-after-example", `${heading} must appear before examples`))
      }
      const order = standardHeadings.indexOf(heading)
      if (order <= currentSectionOrder) {
        diagnostics.push(diagnostic("section-out-of-order", `${heading} is out of order or duplicated`))
      }
      currentSectionOrder = Math.max(currentSectionOrder, order)
      if (sections[heading] !== null) {
        diagnostics.push(diagnostic("duplicate-section", `${heading} may appear at most once`))
      }
      const parsed = parseSection(lines, index)
      diagnostics.push(...parsed.diagnostics)
      sections[heading] = parsed.body
      index = parsed.nextIndex
      continue
    }

    if (isNearMissHeading(line)) {
      diagnostics.push(diagnostic("invalid-heading", `Invalid JSDoc section heading: ${line}`))
      index++
      continue
    }
    if (isBoldOnlyLine(line)) {
      diagnostics.push(diagnostic("unknown-heading", `Unknown JSDoc section heading: ${line}`))
      index++
      continue
    }
    if (isForbiddenMarkdownHeading(line, false)) {
      diagnostics.push(diagnostic("invalid-heading", "Markdown headings are not allowed in JSDoc descriptions"))
      index++
      continue
    }
    diagnostics.push(
      diagnostic("invalid-description", "JSDoc description content must appear under a standard section heading")
    )
    index++
  }

  if (diagnostics.length > 0) {
    return { diagnostics }
  }
  return {
    value: {
      description: {
        short: joinBody(shortLines),
        whenToUse: sections["**When to use**"],
        details: sections["**Details**"],
        gotchas: sections["**Gotchas**"]
      },
      examples
    },
    diagnostics
  }
}

function parseSection(lines: Array<string>, headingIndex: number): {
  readonly body: string | null
  readonly nextIndex: number
  readonly diagnostics: ReadonlyArray<StandardJSDocDiagnostic>
} {
  const diagnostics: Array<StandardJSDocDiagnostic> = []
  if (lines[headingIndex + 1]?.trim() !== "") {
    diagnostics.push(
      diagnostic("invalid-spacing", `${lines[headingIndex].trim()} must be followed by exactly one blank line`)
    )
  }
  let index = headingIndex + 2
  const bodyStart = index
  let inFence = false
  while (index < lines.length) {
    const trimmed = lines[index].trim()
    if (trimmed.startsWith("```")) {
      if (trimmed === "```ts") {
        diagnostics.push(diagnostic("loose-ts-fence", "TypeScript examples must use **Example** (Title) sections"))
      }
      inFence = !inFence
    }
    if (!inFence && trimmed === "" && isHeadingLine(lines[index + 1])) {
      break
    }
    if (!inFence && trimmed !== "" && isForbiddenMarkdownHeading(trimmed, false)) {
      diagnostics.push(diagnostic("invalid-heading", "Markdown headings are not allowed in JSDoc descriptions"))
    }
    if (
      !inFence && isBoldOnlyLine(trimmed) && !standardHeadings.includes(trimmed as StandardHeading) &&
      !trimmed.startsWith("**Example**")
    ) {
      diagnostics.push(diagnostic("unknown-heading", `Unknown JSDoc section heading: ${trimmed}`))
    }
    index++
  }
  const bodyLines = lines.slice(bodyStart, index)
  if (joinBody(bodyLines).trim() === "") {
    diagnostics.push(diagnostic("empty-section", `${lines[headingIndex].trim()} must have a non-empty body`))
  }
  if (bodyLines.at(-1)?.trim() === "") {
    diagnostics.push(diagnostic("invalid-spacing", "Section bodies must not end with extra blank lines"))
  }
  return { body: joinBody(bodyLines), nextIndex: index, diagnostics }
}

function parseExample(lines: Array<string>, headingIndex: number): {
  readonly example?: ParsedExample
  readonly nextIndex: number
  readonly diagnostics: ReadonlyArray<StandardJSDocDiagnostic>
} {
  const diagnostics: Array<StandardJSDocDiagnostic> = []
  const heading = lines[headingIndex].trim()
  const match = /^\*\*Example\*\* \((.+)\)$/.exec(heading)
  if (!match || match[1].trim() === "") {
    diagnostics.push(diagnostic("malformed-example", "TypeScript examples must use **Example** (Title)"))
  }
  if (lines[headingIndex + 1]?.trim() !== "") {
    diagnostics.push(diagnostic("invalid-spacing", "Example headings must be followed by exactly one blank line"))
  }

  let index = headingIndex + 2
  const bodyStart = index
  let fenceIndex = -1
  while (index < lines.length) {
    const trimmed = lines[index].trim()
    if (trimmed === "```ts") {
      fenceIndex = index
      break
    }
    if (trimmed.startsWith("```")) {
      diagnostics.push(diagnostic("malformed-example", "Examples may only contain one TypeScript code fence"))
    }
    if (trimmed === "" && isHeadingLine(lines[index + 1])) {
      break
    }
    if (trimmed.startsWith("@")) {
      break
    }
    index++
  }

  if (fenceIndex === -1) {
    diagnostics.push(diagnostic("malformed-example", "Examples must include a non-empty ```ts fence"))
    return { nextIndex: index, diagnostics }
  }

  const bodyLines = lines.slice(bodyStart, fenceIndex)
  const nonEmptyBody = joinBody(bodyLines).trim() !== ""
  if (nonEmptyBody && bodyLines.at(-1)?.trim() !== "") {
    diagnostics.push(
      diagnostic("invalid-spacing", "Example prose must be separated from code by exactly one blank line")
    )
  }
  const prose = nonEmptyBody ? joinBody(bodyLines.slice(0, bodyLines.at(-1)?.trim() === "" ? -1 : undefined)) : null

  index = fenceIndex + 1
  const codeStart = index
  while (index < lines.length && lines[index].trim() !== "```") {
    if (lines[index].trim() === "```ts") {
      diagnostics.push(diagnostic("malformed-example", "Examples must contain exactly one TypeScript code fence"))
    }
    index++
  }
  const codeLines = lines.slice(codeStart, index)
  if (index >= lines.length) {
    diagnostics.push(diagnostic("malformed-example", "Examples must close the TypeScript code fence"))
  }
  if (joinBody(codeLines).trim() === "") {
    diagnostics.push(diagnostic("malformed-example", "Examples must include non-empty TypeScript code"))
  }
  index++
  if (index < lines.length && lines[index].trim() !== "" && !lines[index].trim().startsWith("@")) {
    diagnostics.push(
      diagnostic("invalid-spacing", "Examples must be separated from following content by exactly one blank line")
    )
  }

  const result = { nextIndex: index, diagnostics }
  return match
    ? { ...result, example: { title: match[1].trim(), body: prose, code: joinBody(codeLines) } }
    : result
}

function joinBody(lines: ReadonlyArray<string>): string {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === "") start++
  while (end > start && lines[end - 1]?.trim() === "") end--
  return lines.slice(start, end).join("\n")
}

function isHeadingLine(line: string | undefined): boolean {
  if (line === undefined) return false
  const trimmed = line.trim()
  return standardHeadings.includes(trimmed as StandardHeading) || trimmed.startsWith("**Example**") ||
    isNearMissHeading(trimmed) || isBoldOnlyLine(trimmed) || isForbiddenMarkdownHeading(trimmed, false)
}

function isNearMissHeading(line: string): boolean {
  return /^\*\*(When to use|When To Use|Details|Gotchas).*\*\*/.test(line) &&
    !standardHeadings.includes(line as StandardHeading)
}

function isBoldOnlyLine(line: string): boolean {
  return /^\*\*[^*]+\*\*(?:\s*)$/.test(line)
}

function isForbiddenMarkdownHeading(line: string, inFence: boolean): boolean {
  return !inFence && /^#{1,6}\s+/.test(line.trim())
}

function parseSeeTag(value: string): ParsedSeeTag {
  return { text: value, links: extractParsedInlineLinks(value) }
}

function extractParsedInlineLinks(source: string): ReadonlyArray<ParsedInlineLink> {
  const links: Array<ParsedInlineLink> = []
  let index = source.indexOf("{@link")
  while (index !== -1) {
    if (!isInlineLinkStart(source, index)) {
      index = source.indexOf("{@link", index + 1)
      continue
    }
    const end = source.indexOf("}", index + "{@link".length)
    if (end === -1) {
      break
    }
    const raw = source.slice(index, end + 1)
    const content = raw.slice("{@link".length, -1).trim()
    const pipeIndex = content.indexOf("|")
    const beforeLabel = pipeIndex === -1 ? content : content.slice(0, pipeIndex).trim()
    const target = beforeLabel.split(/\s+/)[0] ?? ""
    const text = pipeIndex === -1
      ? beforeLabel.slice(target.length).trim() || null
      : content.slice(pipeIndex + 1).trim() || null
    links.push({ raw, target, text })
    index = source.indexOf("{@link", end + 1)
  }
  return links
}

function buildTags(
  scope: DocScope,
  tags: ReadonlyArray<JSDocTag>
): Result<ParsedDeclarationTags | ParsedNamespaceTags | ParsedMemberTags, StandardJSDocParseError> {
  const diagnostics: Array<StandardJSDocDiagnostic> = []
  const allowed = scope === "declaration"
    ? new Set(["deprecated", "see", "category", "since"])
    : scope === "member"
    ? new Set(["deprecated", "default", "see", "since"])
    : new Set(["deprecated", "see", "category", "since"])
  let previousOrder = -1
  const values = new Map<string, Array<string>>()

  for (const tag of tags) {
    if (tag.name === "internal") {
      continue
    }
    if (tag.name === "example") {
      diagnostics.push(
        diagnostic("forbidden-tag", "@example is not allowed; use a canonical **Example** (Title) section")
      )
      continue
    }
    if (!allowed.has(tag.name)) {
      diagnostics.push(
        diagnostic(
          "forbidden-tag",
          `@${tag.name} is not allowed in ${scope === "namespace-declaration" ? "namespace" : scope} JSDoc`
        )
      )
      continue
    }
    const order = tagOrder.get(tag.name) ?? previousOrder
    if (order < previousOrder) {
      diagnostics.push(diagnostic("tag-out-of-order", `@${tag.name} is out of order in JSDoc`))
    }
    previousOrder = Math.max(previousOrder, order)
    values.set(tag.name, [...values.get(tag.name) ?? [], tag.value.trim()])
  }

  const singletonTags = scope === "member" ? ["deprecated", "default", "since"] : ["deprecated", "category", "since"]
  for (const tag of singletonTags) {
    if ((values.get(tag)?.length ?? 0) > 1) {
      diagnostics.push(diagnostic("duplicate-tag", `JSDoc blocks may contain at most one @${tag} tag`))
    }
  }

  const see = values.get("see") ?? []
  for (const value of see) {
    if (value === "") {
      diagnostics.push(diagnostic("empty-tag", "@see must include a value"))
    }
  }
  const deprecated = values.get("deprecated")?.[0] ?? null
  if (deprecated === "") diagnostics.push(diagnostic("empty-tag", "@deprecated must include a message"))
  const since = values.get("since")?.[0] ?? null
  if ((scope === "declaration" || scope === "namespace" || scope === "namespace-declaration") && since === null) {
    diagnostics.push(
      diagnostic(
        "missing-tag",
        scope === "declaration" ? "Public JSDoc must include @since" : "Namespace JSDoc must include @since"
      )
    )
  }
  if (since !== null && !stableSemverRegex.test(since)) {
    diagnostics.push(diagnostic("invalid-since", "@since must be a stable semver version like 1.2.3"))
  }

  if (scope === "declaration") {
    const category = values.get("category")?.[0] ?? null
    if (category === null) diagnostics.push(diagnostic("missing-tag", "Public JSDoc must include @category"))
    if (category === "") diagnostics.push(diagnostic("empty-tag", "@category must include a value"))
    if (diagnostics.length > 0 || category === null || since === null) {
      return { _tag: "Failure", error: { diagnostics } }
    }
    return { _tag: "Success", value: { category, since, deprecated, see: see.map(parseSeeTag) } }
  }

  if (scope === "member") {
    const defaultValue = values.get("default")?.[0] ?? null
    if (defaultValue === "") diagnostics.push(diagnostic("empty-tag", "@default must include a value"))
    if (diagnostics.length > 0) return { _tag: "Failure", error: { diagnostics } }
    return { _tag: "Success", value: { since, default: defaultValue, deprecated, see: see.map(parseSeeTag) } }
  }

  const category = values.get("category")?.[0] ?? null
  if (category === "") diagnostics.push(diagnostic("empty-tag", "@category must include a value"))
  if (diagnostics.length > 0 || since === null) return { _tag: "Failure", error: { diagnostics } }
  return { _tag: "Success", value: { category, since, deprecated, see: see.map(parseSeeTag) } }
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
}

function parseTsConfig(tsconfigPath: string): ParsedConfigResult {
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (config.error !== undefined) {
    return { error: `Unable to read TypeScript config ${tsconfigPath}: ${formatDiagnostic(config.error)}` }
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(tsconfigPath))
  if (parsed.errors.length > 0) {
    return {
      error: `Unable to parse TypeScript config ${tsconfigPath}: ${parsed.errors.map(formatDiagnostic).join("; ")}`
    }
  }
  return { parsed }
}

function collectTsConfigFiles(tsconfigPath: string, seen: Set<string>, fileNames: Set<string>): ParsedConfigResult {
  if (seen.has(tsconfigPath)) return {}
  seen.add(tsconfigPath)
  const result = parseTsConfig(tsconfigPath)
  if (result.error !== undefined || result.parsed === undefined) return result
  for (const fileName of result.parsed.fileNames) fileNames.add(fileName)
  for (const reference of result.parsed.projectReferences ?? []) {
    const referenceResult = collectTsConfigFiles(ts.resolveProjectReferencePath(reference), seen, fileNames)
    if (referenceResult.error !== undefined) return referenceResult
  }
  return result
}

function getProgram(tsconfigPath: string): ProgramCacheEntry {
  const cached = programCache.get(tsconfigPath)
  if (cached !== undefined) return cached
  const fileNames = new Set<string>()
  const result = collectTsConfigFiles(tsconfigPath, new Set(), fileNames)
  if (result.error !== undefined || result.parsed === undefined) {
    const entry = { error: result.error ?? `Unable to parse TypeScript config ${tsconfigPath}`, reported: false }
    programCache.set(tsconfigPath, entry)
    return entry
  }
  const program = ts.createProgram(Array.from(fileNames), result.parsed.options)
  const entry = { program, ...createProgramSymbolIndex(program), reported: false }
  programCache.set(tsconfigPath, entry)
  return entry
}

function createProgramSymbolIndex(program: ts.Program) {
  const checker = program.getTypeChecker()
  const modulesByName = new Map<string, ts.Symbol>()
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    if (moduleSymbol === undefined) continue
    const moduleName = path.basename(sourceFile.fileName, path.extname(sourceFile.fileName))
    modulesByName.set(moduleName, moduleSymbol)
    modulesByName.set(`${moduleName}_`, moduleSymbol)
  }
  return { modulesByName }
}

function getExport(symbol: ts.Symbol, name: string, checker: ts.TypeChecker, location: ts.Node): ts.Symbol | undefined {
  const target = (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol)
  if (target.exports?.has(name as ts.__String)) return target.exports.get(name as ts.__String)
  if (target.members?.has(name as ts.__String)) return target.members.get(name as ts.__String)
  return checker.getTypeOfSymbolAtLocation(target, location).getProperty(name) ??
    checker.getDeclaredTypeOfSymbol(target).getProperty(name)
}

function resolveDottedSymbol(
  root: ts.Symbol | undefined,
  parts: ReadonlyArray<string>,
  checker: ts.TypeChecker,
  location: ts.Node
): ts.Symbol | undefined {
  let current = root
  for (const part of parts) {
    if (current === undefined) return undefined
    current = getExport(current, part, checker, location)
  }
  return current
}

function resolveJSDocLinkSymbol(
  link: ts.JSDocLink,
  target: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  entry: ProgramCacheEntry
): ts.Symbol | undefined {
  if (link.name !== undefined) {
    const symbol = checker.getSymbolAtLocation(link.name)
    if (symbol !== undefined) return symbol
  }
  const parts = target.split(".")
  if (parts.some((part) => part === "")) return undefined
  const [root, ...members] = parts
  if (root === undefined) return undefined
  const sourceModule = checker.getSymbolAtLocation(sourceFile)
  const lexical = checker.resolveName(root, sourceFile, ts.SymbolFlags.All, false)
  const candidates = [
    lexical,
    sourceModule === undefined ? undefined : getExport(sourceModule, root, checker, sourceFile),
    entry.modulesByName?.get(root)
  ]
  return candidates.map((candidate) => resolveDottedSymbol(candidate, members, checker, sourceFile)).find((symbol) =>
    symbol !== undefined
  )
}

function isInlineLinkStart(source: string, index: number): boolean {
  if (!source.startsWith("{@link", index)) return false
  const next = source[index + "{@link".length]
  return next === undefined || /\s|}/.test(next)
}

function hasInlineLink(block: JSDocBlock): boolean {
  return block.lines.some((line) => {
    let index = line.indexOf("{@link")
    while (index !== -1) {
      if (isInlineLinkStart(line, index)) return true
      index = line.indexOf("{@link", index + 1)
    }
    return false
  })
}

function extractInlineLinkTarget(linkText: string): string {
  const content = linkText.slice("{@link".length, linkText.endsWith("}") ? -1 : undefined).trim()
  const pipeIndex = content.indexOf("|")
  const beforeLabel = pipeIndex === -1 ? content : content.slice(0, pipeIndex).trim()
  return beforeLabel.split(/\s+/)[0] ?? ""
}

function malformedInlineLinks(block: JSDocBlock): Array<string> {
  const source = block.lines.join("\n")
  const malformed: Array<string> = []
  let index = source.indexOf("{@link")
  while (index !== -1) {
    if (!isInlineLinkStart(source, index)) {
      index = source.indexOf("{@link", index + 1)
      continue
    }
    const end = source.indexOf("}", index + "{@link".length)
    const text = end === -1 ? source.slice(index).split(/\r?\n/, 1)[0] : source.slice(index, end + 1)
    if (end === -1 || extractInlineLinkTarget(text) === "") malformed.push(text)
    index = source.indexOf("{@link", end === -1 ? index + 1 : end + 1)
  }
  return malformed
}

function collectJSDocLinks(sourceFile: ts.SourceFile, block: JSDocBlock): Array<ts.JSDocLink> {
  const links: Array<ts.JSDocLink> = []
  function inspectJSDoc(node: ts.Node) {
    for (const jsdoc of (node as { readonly jsDoc?: ReadonlyArray<ts.JSDoc> }).jsDoc ?? []) {
      if (jsdoc.pos !== block.range[0] || jsdoc.end !== block.range[1]) continue
      ts.forEachChild(jsdoc, function visit(child) {
        if (ts.isJSDocLink(child)) links.push(child)
        ts.forEachChild(child, visit)
      })
    }
  }
  function visit(node: ts.Node) {
    inspectJSDoc(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return links
}

/**
 * Parses all public standard JSDoc blocks from an ESTree program.
 *
 * **Details**
 *
 * The parser returns root declarations and declared namespaces in the same grouped shape used by the rule dump output. It reports diagnostics for unsupported public constructs, missing required public JSDoc, malformed standard sections, invalid tags, and namespace exports that do not follow the supported type-only shape.
 *
 * @category parsing
 * @since 4.0.0
 */
export function parseStandardJSDocsFromESTree(input: {
  readonly source: string
  readonly program: ESTree.Program
}): Result<ParsedStandardJSDocFile, StandardJSDocParseError> {
  const diagnostics: Array<StandardJSDocDiagnostic> = []
  const declarations: Array<ParsedRootDeclaration> = []
  const namespaces: Array<ParsedNamespace> = []

  const addDiagnostics = (items: ReadonlyArray<StandardJSDocDiagnostic>) => {
    diagnostics.push(...items)
  }

  const parseDocumented = (node: AstNode, scope: DocScope, required = true) => {
    const block = findLeadingJSDoc(input.source, node)
    if (block?.internal) {
      return undefined
    }
    if (block === undefined) {
      if (required) {
        diagnostics.push(
          diagnostic("missing-jsdoc", scope === "member" ? "Member JSDoc is required" : "Public JSDoc is required")
        )
      }
      return undefined
    }
    addDiagnostics(block.diagnostics)
    if (block.parsed === undefined) {
      return undefined
    }
    const tags = buildTags(scope, block.parsed.tags)
    if (tags._tag === "Failure") {
      addDiagnostics(tags.error.diagnostics)
      return undefined
    }
    return { core: block.parsed, tags: tags.value }
  }

  const parseMembersFromFunction = (node: AstNode | null | undefined): Array<ParsedMember> => {
    if (
      !node ||
      ![
        "FunctionDeclaration",
        "FunctionExpression",
        "TSDeclareFunction",
        "TSEmptyBodyFunctionExpression",
        "ArrowFunctionExpression"
      ].includes(node.type)
    ) {
      return []
    }
    return parseMembersFromType(node.returnType?.typeAnnotation)
  }

  const parseNestedMembersFromMember = (member: AstNode): Array<ParsedMember> => [
    ...parseMembersFromType(member.typeAnnotation?.typeAnnotation),
    ...parseMembersFromFunction(member.value),
    ...parseMembersFromFunction(member)
  ]

  const parseMembers = (members: ReadonlyArray<AstNode> | undefined): Array<ParsedMember> => {
    const out: Array<ParsedMember> = []
    for (const member of members ?? []) {
      if (!shouldParseMember(member)) {
        out.push(...parseNestedMembersFromMember(member))
        continue
      }
      const documented = parseDocumented(member, "member", false)
      if (documented === undefined) {
        continue
      }
      const name = getRequiredNodeName(member, diagnostics, "Documented member")
      if (name === undefined) {
        continue
      }
      out.push({
        name,
        description: documented.core.description,
        examples: documented.core.examples,
        tags: documented.tags as ParsedMemberTags,
        members: parseNestedMembersFromMember(member)
      })
    }
    return out
  }

  const parseMembersFromType = (type: AstNode | null | undefined): Array<ParsedMember> => {
    if (!type) return []
    switch (type.type) {
      case "TSTypeAnnotation":
        return parseMembersFromType(type.typeAnnotation)
      case "TSTypeLiteral":
        return parseMembers(type.members)
      case "TSUnionType":
      case "TSIntersectionType":
        return (type.types ?? []).flatMap(parseMembersFromType)
      case "TSParenthesizedType":
      case "TSTypeOperator":
      case "TSOptionalType":
      case "TSRestType":
        return parseMembersFromType(type.typeAnnotation)
      case "TSArrayType":
        return parseMembersFromType(type.elementType)
      case "TSConditionalType":
        return [
          ...parseMembersFromType(type.checkType),
          ...parseMembersFromType(type.extendsType),
          ...parseMembersFromType(type.trueType),
          ...parseMembersFromType(type.falseType)
        ]
      case "TSTypeReference":
        return (type.typeParameters?.params ?? []).flatMap(parseMembersFromType)
      case "TSMappedType":
        return parseMembersFromType(type.typeAnnotation)
      case "TSIndexedAccessType":
        return [...parseMembersFromType(type.objectType), ...parseMembersFromType(type.indexType)]
      case "TSFunctionType":
      case "TSConstructorType":
        return parseMembersFromType(type.returnType?.typeAnnotation)
      default:
        return []
    }
  }

  const parseDeclarationMembers = (declaration: AstNode): Array<ParsedMember> => {
    switch (declaration.type) {
      case "TSInterfaceDeclaration":
        return parseMembers(declaration.body?.body)
      case "ClassDeclaration":
      case "ClassExpression":
        return parseMembers(declaration.body?.body)
      case "TSTypeAliasDeclaration":
        return parseMembersFromType(declaration.typeAnnotation)
      case "VariableDeclaration": {
        const out: Array<ParsedMember> = []
        for (const declarator of declaration.declarations ?? []) {
          out.push(...parseMembersFromType(declarator.id?.typeAnnotation?.typeAnnotation))
          out.push(...parseMembersFromFunction(declarator.init))
        }
        return out
      }
      case "FunctionDeclaration":
      case "TSDeclareFunction":
        return parseMembersFromFunction(declaration)
      default:
        return []
    }
  }

  const parseNamespace = (exportNode: AstNode, declaration: AstNode): ParsedNamespace | undefined => {
    if (isAmbientModuleLikeForSource(input.source, declaration)) {
      return undefined
    }
    if (!isDeclareNamespaceForSource(input.source, declaration)) {
      diagnostics.push(diagnostic("namespace-declare", "Namespaces must be declared with declare namespace"))
      return undefined
    }
    const documented = parseDocumented(exportNode, "namespace")
    if (documented === undefined) {
      return undefined
    }
    const namespaceDeclarations: Array<ParsedNamespaceDeclaration> = []
    const nestedNamespaces: Array<ParsedNamespace> = []
    for (const statement of declaration.body?.body ?? []) {
      if (statement.type !== "ExportNamedDeclaration" || !statement.declaration) {
        if (statement.type === "ExportAllDeclaration") {
          continue
        }
        continue
      }
      const nestedDeclaration = statement.declaration as AstNode
      if (nestedDeclaration.type === "TSModuleDeclaration") {
        const nested = parseNamespace(statement, nestedDeclaration)
        if (nested !== undefined) nestedNamespaces.push(nested)
        continue
      }
      if (nestedDeclaration.type === "TSEnumDeclaration") {
        diagnostics.push(diagnostic("enum", "Enums are not allowed"))
        continue
      }
      if (getStandaloneDeclarationBucket(nestedDeclaration) !== "type") {
        diagnostics.push(diagnostic("namespace-value", "Namespace exports must be type declarations"))
        continue
      }
      const nestedDocumented = parseDocumented(statement, "namespace-declaration")
      if (nestedDocumented === undefined) {
        continue
      }
      const name = getRequiredNodeName(nestedDeclaration, diagnostics, "Namespace declaration")
      if (name === undefined) {
        continue
      }
      namespaceDeclarations.push({
        name,
        description: nestedDocumented.core.description,
        examples: nestedDocumented.core.examples,
        tags: nestedDocumented.tags as ParsedNamespaceTags,
        members: parseDeclarationMembers(nestedDeclaration)
      })
    }
    const name = getRequiredNodeName(declaration, diagnostics, "Namespace")
    if (name === undefined) {
      return undefined
    }
    return {
      name,
      description: documented.core.description,
      examples: documented.core.examples,
      tags: documented.tags as ParsedNamespaceTags,
      declarations: namespaceDeclarations,
      namespaces: nestedNamespaces
    }
  }

  for (const statement of input.program.body as ReadonlyArray<AstNode>) {
    if (statement.type === "ExportDefaultDeclaration") {
      continue
    }
    if (statement.type === "ExportAllDeclaration") {
      continue
    }
    if (statement.type !== "ExportNamedDeclaration") {
      continue
    }
    if (statement.declaration) {
      const declaration = statement.declaration as AstNode
      if (declaration.type === "TSEnumDeclaration") {
        diagnostics.push(diagnostic("enum", "Enums are not allowed"))
        continue
      }
      if (declaration.type === "TSModuleDeclaration") {
        const namespace = parseNamespace(statement, declaration)
        if (namespace !== undefined) namespaces.push(namespace)
        continue
      }
      const bucket = getStandaloneDeclarationBucket(declaration)
      if (bucket === undefined) {
        continue
      }
      const documented = parseDocumented(statement, "declaration")
      if (documented === undefined) {
        continue
      }
      const name = getRequiredNodeName(declaration, diagnostics, "Root declaration")
      if (name === undefined) {
        continue
      }
      declarations.push({
        name,
        bucket,
        description: documented.core.description,
        examples: documented.core.examples,
        tags: documented.tags as ParsedDeclarationTags,
        members: parseDeclarationMembers(declaration)
      })
    } else {
      if ((statement.specifiers?.length ?? 0) === 0) {
        diagnostics.push(diagnostic("empty-export", "Empty export declarations are not allowed"))
      }
      for (const specifier of statement.specifiers ?? []) {
        const documented = parseDocumented(specifier, "declaration")
        if (documented === undefined) {
          continue
        }
        const name = getRequiredExportedSpecifierName(specifier, diagnostics)
        if (name === undefined) {
          continue
        }
        declarations.push({
          name,
          bucket: statement.exportKind === "type" || specifier.exportKind === "type" ? "type" : "value",
          description: documented.core.description,
          examples: documented.core.examples,
          tags: documented.tags as ParsedDeclarationTags,
          members: []
        })
      }
    }
  }

  return diagnostics.length > 0
    ? { _tag: "Failure", error: { diagnostics: uniqueDiagnostics(diagnostics) } }
    : { _tag: "Success", value: { declarations, namespaces } }
}

function getStandaloneDeclarationBucket(declaration: AstNode): ExportBucket | undefined {
  switch (declaration.type) {
    case "VariableDeclaration":
    case "FunctionDeclaration":
    case "TSDeclareFunction":
    case "ClassDeclaration":
    case "ClassExpression":
      return "value"
    case "TSTypeAliasDeclaration":
    case "TSInterfaceDeclaration":
      return "type"
    default:
      return undefined
  }
}

function isDeclareNamespaceForSource(source: string, node: AstNode): boolean {
  return node.declare === true ||
    /\bdeclare\s+namespace\b/.test(source.slice(node.range[0], Math.min(node.range[1], node.range[0] + 80))) ||
    isInsideDeclareNamespaceForSource(source, node.range[0])
}

function isInsideDeclareNamespaceForSource(source: string, index: number): boolean {
  const prefix = stripCommentsForNamespaceScan(source.slice(0, index))
  const matches = Array.from(prefix.matchAll(/\bdeclare\s+(?:namespace|module|global)\b/g)).reverse()
  for (const match of matches) {
    const declarationIndex = match.index
    const openBraceIndex = prefix.indexOf("{", declarationIndex)
    if (openBraceIndex === -1) {
      continue
    }
    let depth = 0
    for (let position = openBraceIndex; position < prefix.length; position++) {
      const character = prefix[position]
      if (character === "{") {
        depth++
      } else if (character === "}") {
        depth--
      }
    }
    if (depth > 0) {
      return true
    }
  }
  return false
}

function stripCommentsForNamespaceScan(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length))
    .replace(/\/\/[^\n\r]*/g, (comment) => " ".repeat(comment.length))
}

function isAmbientModuleLikeForSource(source: string, node: AstNode): boolean {
  return node.type === "TSModuleDeclaration" && node.id?.type !== "Identifier" &&
    !/\bnamespace\b/.test(source.slice(node.range[0], Math.min(node.range[1], node.range[0] + 80)))
}

function shouldParseMember(member: AstNode): boolean {
  if (member.kind === "constructor") return false
  if (member.accessibility === "private" || member.accessibility === "protected") return false
  if (
    member.type === "TSCallSignatureDeclaration" || member.type === "TSConstructSignatureDeclaration" ||
    member.type === "TSIndexSignature"
  ) return false
  return true
}

function getNodeName(node: AstNode): string {
  const direct = node.name ?? node.id?.name ?? node.key?.name ?? node.key?.value ?? node.local?.name ??
    node.exported?.name
  if (typeof direct === "string" && direct.length > 0) {
    return direct
  }
  if (node.type === "VariableDeclaration") {
    return ((node.declarations ?? []) as ReadonlyArray<AstNode>).map(getNodeName).filter((name) => name.length > 0)
      .join(", ")
  }
  if (node.type === "VariableDeclarator") {
    return getNodeName(node.id)
  }
  if (node.type === "AssignmentPattern") {
    return getNodeName(node.left)
  }
  if (node.type === "RestElement") {
    return getNodeName(node.argument)
  }
  return ""
}

function getExportedSpecifierName(node: AstNode): string {
  return node.exported?.name ?? node.exported?.value ?? node.local?.name ?? ""
}

function getRequiredNodeName(
  node: AstNode,
  diagnostics: Array<StandardJSDocDiagnostic>,
  label: string
): string | undefined {
  const name = getNodeName(node)
  if (name.length > 0) {
    return name
  }
  diagnostics.push(diagnostic("missing-name", `${label} name could not be determined`))
  return undefined
}

function getRequiredExportedSpecifierName(
  node: AstNode,
  diagnostics: Array<StandardJSDocDiagnostic>
): string | undefined {
  const name = getExportedSpecifierName(node)
  if (name.length > 0) {
    return name
  }
  diagnostics.push(diagnostic("missing-name", "Export specifier name could not be determined"))
  return undefined
}

const rule: CreateRule = {
  meta: {
    type: "problem",
    docs: { description: "Enforce Effect's public API JSDoc structure" },
    schema: [
      {
        type: "object",
        properties: {
          include: { type: "array", items: { type: "string" } },
          exclude: { type: "array", items: { type: "string" } },
          tsconfig: { type: "string" }
        },
        additionalProperties: false
      }
    ]
  },
  create(context) {
    const options = (context.options[0] as RuleOptions | undefined) ?? {}
    const source = getSourceText(context)
    const cwd = getCwd(context)
    const matchesFile = createStandardJSDocFileMatcher({
      cwd,
      ...(options.include === undefined ? {} : { include: options.include }),
      ...(options.exclude === undefined ? {} : { exclude: options.exclude })
    })
    if (!matchesFile(context.filename)) return {} as Visitor

    const tsconfigPath = path.resolve(cwd, options.tsconfig ?? "tsconfig.json")
    let programNode: ESTree.Program | undefined
    const checkedExports = new Set<string>()
    const checkedFunctionOverloads = new Set<string>()
    const checkedNamespaceMemberExports = new Set<string>()

    function report(node: AstNode, message: string) {
      recordDumpError(cwd)
      context.report({ node: node as ESTree.Node, message })
    }

    function getLeadingBlock(node: AstNode): JSDocBlock | undefined {
      return findLeadingJSDoc(source, node)
    }

    function reportDiagnostics(node: AstNode, diagnostics: ReadonlyArray<StandardJSDocDiagnostic>) {
      for (const item of diagnostics) report(node, item.message)
    }

    function validateLinks(node: AstNode, block: JSDocBlock) {
      if (!hasInlineLink(block)) return
      for (const link of malformedInlineLinks(block)) report(node, `Malformed JSDoc inline link: ${link}`)
      const entry = getProgram(tsconfigPath)
      if (entry.error !== undefined) {
        if (!entry.reported) {
          entry.reported = true
          report(node, entry.error)
        }
        return
      }
      const program = entry.program
      if (program === undefined) return
      const sourceFile = program.getSourceFile(context.filename)
      if (sourceFile === undefined) {
        if (!entry.reported) {
          entry.reported = true
          report(node, `Unable to validate JSDoc links: ${context.filename} is not included in ${tsconfigPath}`)
        }
        return
      }
      const checker = program.getTypeChecker()
      for (const link of collectJSDocLinks(sourceFile, block)) {
        const text = link.getText(sourceFile)
        const target = extractInlineLinkTarget(text)
        if (target === "") continue
        if (urlRegex.test(target)) report(node, `JSDoc inline link must target a TypeScript symbol: ${text}`)
        else if (resolveJSDocLinkSymbol(link, target, sourceFile, checker, entry) === undefined) {
          report(node, `Unresolved JSDoc inline link: ${text}`)
        }
      }
    }

    function validateBlock(node: AstNode, block: JSDocBlock, scope: DocScope): boolean {
      if (block.internal) return false
      reportDiagnostics(node, block.diagnostics)
      if (block.parsed !== undefined) {
        const tags = buildTags(scope, block.parsed.tags)
        if (tags._tag === "Failure") reportDiagnostics(node, tags.error.diagnostics)
      }
      validateLinks(node, block)
      return true
    }

    function requireBlock(node: AstNode, scope: DocScope): boolean {
      const block = getLeadingBlock(node)
      if (!block) {
        report(node, scope === "member" ? "Member JSDoc is required" : "Public JSDoc is required")
        return true
      }
      return validateBlock(node, block, scope)
    }

    function inspectTypeAnnotation(typeAnnotation: AstNode | null | undefined) {
      if (typeAnnotation?.type === "TSTypeAnnotation") inspectType(typeAnnotation.typeAnnotation)
    }

    function inspectParam(param: AstNode) {
      if (param.type === "TSParameterProperty") return inspectParam(param.parameter)
      inspectTypeAnnotation(param.typeAnnotation)
      if (param.type === "RestElement") inspectTypeAnnotation(param.argument?.typeAnnotation)
    }

    function inspectFunctionLike(node: AstNode | null | undefined) {
      if (!node) return
      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "TSDeclareFunction",
          "TSEmptyBodyFunctionExpression",
          "ArrowFunctionExpression"
        ].includes(node.type)
      ) {
        for (const param of node.params ?? []) inspectParam(param)
        inspectTypeAnnotation(node.returnType)
      }
    }

    function inspectType(type: AstNode | null | undefined) {
      if (!type) return
      switch (type.type) {
        case "TSTypeLiteral":
          checkTypeLiteralMembers(type.members)
          break
        case "TSUnionType":
        case "TSIntersectionType":
          for (const item of type.types ?? []) inspectType(item)
          break
        case "TSParenthesizedType":
        case "TSTypeOperator":
        case "TSOptionalType":
        case "TSRestType":
          inspectType(type.typeAnnotation)
          break
        case "TSArrayType":
          inspectType(type.elementType)
          break
        case "TSConditionalType":
          inspectType(type.checkType)
          inspectType(type.extendsType)
          inspectType(type.trueType)
          inspectType(type.falseType)
          break
        case "TSTypeReference":
          for (const param of type.typeParameters?.params ?? []) inspectType(param)
          break
        case "TSMappedType":
          inspectType(type.typeAnnotation)
          break
        case "TSIndexedAccessType":
          inspectType(type.objectType)
          inspectType(type.indexType)
          break
        case "TSFunctionType":
        case "TSConstructorType":
          for (const param of type.params ?? []) inspectParam(param)
          inspectTypeAnnotation(type.returnType)
          break
      }
    }

    function shouldCheckMember(member: AstNode): boolean {
      if (member.kind === "constructor") return false
      if (member.accessibility === "private" || member.accessibility === "protected") return false
      if (
        member.type === "TSCallSignatureDeclaration" || member.type === "TSConstructSignatureDeclaration" ||
        member.type === "TSIndexSignature"
      ) return false
      return true
    }

    function checkMember(member: AstNode) {
      if (!shouldCheckMember(member)) {
        inspectMemberTypes(member)
        return
      }
      const block = getLeadingBlock(member)
      if (block?.internal) return
      if (block) {
        validateBlock(member, block, "member")
      }
      inspectMemberTypes(member)
    }

    function inspectMemberTypes(member: AstNode) {
      inspectTypeAnnotation(member.typeAnnotation)
      inspectFunctionLike(member.value)
      inspectFunctionLike(member)
      if (member.returnType) inspectTypeAnnotation(member.returnType)
    }

    function checkTypeLiteralMembers(members: ReadonlyArray<AstNode> | undefined) {
      for (const member of members ?? []) checkMember(member)
    }

    function checkClassMembers(declaration: AstNode) {
      for (const member of declaration.body?.body ?? []) checkMember(member)
    }

    function checkVariableDeclaration(node: AstNode) {
      for (const declarator of node.declarations ?? []) {
        inspectTypeAnnotation(declarator.id?.typeAnnotation)
        inspectFunctionLike(declarator.init)
      }
    }

    function checkDeclarationMembers(declaration: AstNode) {
      switch (declaration.type) {
        case "VariableDeclaration":
          checkVariableDeclaration(declaration)
          break
        case "FunctionDeclaration":
        case "TSDeclareFunction":
          inspectFunctionLike(declaration)
          break
        case "ClassDeclaration":
        case "ClassExpression":
          checkClassMembers(declaration)
          break
        case "TSTypeAliasDeclaration":
          inspectType(declaration.typeAnnotation)
          break
        case "TSInterfaceDeclaration":
          checkTypeLiteralMembers(declaration.body?.body)
          break
        case "TSModuleDeclaration":
          checkNamespaceMembers(declaration)
          break
      }
    }

    function getDeclarationBucket(declaration: AstNode): ExportBucket | undefined {
      switch (declaration.type) {
        case "VariableDeclaration":
        case "FunctionDeclaration":
        case "TSDeclareFunction":
        case "ClassDeclaration":
        case "ClassExpression":
          return "value"
        case "TSTypeAliasDeclaration":
        case "TSInterfaceDeclaration":
          return "type"
        default:
          return undefined
      }
    }

    function shouldCheckOverload(declaration: AstNode): boolean {
      if (declaration.type !== "FunctionDeclaration" && declaration.type !== "TSDeclareFunction") return true
      const name = declaration.id?.name
      if (typeof name !== "string") return true
      if (declaration.body === null) {
        if (checkedFunctionOverloads.has(name)) return false
        checkedFunctionOverloads.add(name)
        return true
      }
      return !checkedFunctionOverloads.has(name)
    }

    function getNodeKey(node: AstNode): string {
      return `${node.range[0]}:${node.range[1]}`
    }

    function isDeclareNamespace(node: AstNode): boolean {
      return isDeclareNamespaceForSource(source, node)
    }

    function isAmbientModuleLike(node: AstNode): boolean {
      return node.type === "TSModuleDeclaration" && node.id?.type !== "Identifier" &&
        !/\bnamespace\b/.test(source.slice(node.range[0], Math.min(node.range[1], node.range[0] + 80)))
    }

    function checkNamespaceMembers(namespaceNode: AstNode) {
      for (const statement of namespaceNode.body?.body ?? []) {
        if (statement.type === "ExportNamedDeclaration" && statement.declaration) {
          checkedNamespaceMemberExports.add(getNodeKey(statement))
          checkNamespaceMemberExport(statement, statement.declaration)
        } else if (statement.type === "ExportAllDeclaration") {
          continue
        } else if (statement.type === "ExportDefaultDeclaration") {
          continue
        }
      }
    }

    function checkNamespaceMemberExport(exportNode: AstNode, declaration: AstNode) {
      if (declaration.type === "TSEnumDeclaration") {
        report(exportNode, "Enums are not allowed")
        return
      }
      if (declaration.type === "TSModuleDeclaration") {
        if (isAmbientModuleLike(declaration)) return
        if (!isDeclareNamespace(declaration)) {
          report(exportNode, "Namespaces must be declared with declare namespace")
          return
        }
        const block = getLeadingBlock(exportNode)
        if (block?.internal) return
        if (requireBlock(exportNode, "namespace")) checkNamespaceMembers(declaration)
        return
      }
      const bucket = getDeclarationBucket(declaration)
      if (bucket !== "type") {
        report(exportNode, "Namespace exports must be type declarations")
        return
      }
      if (!shouldCheckOverload(declaration)) return
      const block = getLeadingBlock(exportNode)
      if (block?.internal) return
      if (requireBlock(exportNode, "namespace-declaration")) checkDeclarationMembers(declaration)
    }

    function checkExportedDeclaration(exportNode: AstNode, declaration: AstNode) {
      const key = getNodeKey(exportNode)
      if (checkedNamespaceMemberExports.has(key) || checkedExports.has(key)) return
      checkedExports.add(key)
      if (declaration.type === "TSEnumDeclaration") {
        report(exportNode, "Enums are not allowed")
        return
      }
      if (declaration.type === "TSModuleDeclaration") {
        if (isAmbientModuleLike(declaration)) return
        if (!isDeclareNamespace(declaration)) {
          report(exportNode, "Namespaces must be declared with declare namespace")
          return
        }
        const block = getLeadingBlock(exportNode)
        if (block?.internal) return
        if (requireBlock(exportNode, "namespace")) checkNamespaceMembers(declaration)
        return
      }
      const bucket = getDeclarationBucket(declaration)
      if (!bucket || !shouldCheckOverload(declaration)) return
      const block = getLeadingBlock(exportNode)
      if (block?.internal) return
      if (requireBlock(exportNode, "declaration")) checkDeclarationMembers(declaration)
    }

    function specifierBucket(exportNode: AstNode, specifier: AstNode): ExportBucket {
      return exportNode.exportKind === "type" || specifier.exportKind === "type" ? "type" : "value"
    }

    function checkExportSpecifier(exportNode: AstNode, specifier: AstNode) {
      const block = getLeadingBlock(specifier)
      if (block?.internal) return
      if (!block) {
        report(specifier, "Public JSDoc is required")
        return
      }
      // Bucket is syntax-authoritative for specifier exports. Parsing/tag rules are the same for all public declarations.
      specifierBucket(exportNode, specifier)
      validateBlock(specifier, block, "declaration")
    }

    return {
      Program(node: ESTree.Node) {
        programNode = node as ESTree.Program
      },
      "Program:exit"() {
        if (programNode === undefined) {
          return
        }
        const result = parseStandardJSDocsFromESTree({ source, program: programNode })
        if (result._tag === "Success" && (result.value.declarations.length > 0 || result.value.namespaces.length > 0)) {
          const imports = resolveStandardJSDocImports(cwd, context.filename)
          if (imports._tag === "Failure") {
            report(
              programNode as unknown as AstNode,
              `Unable to resolve standard-jsdoc imports: ${imports.error}. Add the missing barrel/package export or exclude this file from standard-jsdoc.`
            )
            return
          }
          registerDump(cwd, {
            file: normalizePathName(path.relative(cwd, context.filename)),
            imports: imports.value,
            ...result.value
          })
        }
      },
      ExportNamedDeclaration(node: ESTree.Node) {
        const exportNode = node as AstNode
        if (exportNode.declaration) {
          checkExportedDeclaration(exportNode, exportNode.declaration)
          return
        }
        if ((exportNode.specifiers?.length ?? 0) === 0) {
          report(exportNode, "Empty export declarations are not allowed")
          return
        }
        for (const specifier of exportNode.specifiers ?? []) checkExportSpecifier(exportNode, specifier)
      },
      ExportDefaultDeclaration(_node: ESTree.Node) {
        // Default exports are intentionally ignored by this rule.
      },
      ExportAllDeclaration(_node: ESTree.Node) {
        // Export-all declarations are intentionally ignored by this rule.
      }
    } as Visitor
  }
}

export default rule
