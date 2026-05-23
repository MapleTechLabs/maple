import rule, { parseStandardJSDoc, parseStandardJSDocsFromESTree } from "@effect/oxc/oxlint/rules/standard-jsdoc"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { createTestContext } from "./utils.ts"

interface TestNode {
  readonly type: string
  readonly range: [number, number]
  readonly [key: string]: any
}

function rangeOf(source: string, search: string): [number, number] {
  const start = source.indexOf(search)
  if (start === -1) throw new Error(`Unable to find ${search}`)
  return [start, start + search.length]
}

function node(source: string, search: string, type: string, extra: Record<string, unknown> = {}): TestNode {
  return { type, range: rangeOf(source, search), ...extra }
}

function exportNamed(
  source: string,
  search: string,
  declaration: TestNode | null,
  extra: Record<string, unknown> = {}
): TestNode {
  return node(source, search, "ExportNamedDeclaration", { declaration, source: null, specifiers: [], ...extra })
}

function runRuleWithSource(
  source: string,
  entries: Array<{ readonly visitor: string; readonly node: TestNode }>,
  ruleOptions: Array<unknown> = [],
  contextOptions: { readonly filename?: string; readonly cwd?: string } = {}
) {
  const { context, errors } = createTestContext({
    sourceCode: source,
    filename: contextOptions.filename ?? "/repo/packages/sample/src/Foo.ts",
    cwd: contextOptions.cwd ?? "/repo",
    ruleOptions
  })
  const visitors = rule.create(context as never)
  for (const { visitor, node } of entries) {
    const handler = visitors[visitor as keyof typeof visitors]
    if (handler) (handler as (node: unknown) => void)(node)
  }
  return errors
}

function createTypescriptProject(source: string, files: Record<string, string> = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "standard-jsdoc-"))
  const filename = path.join(cwd, "src", "Foo.ts")
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(
    path.join(cwd, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        target: "ES2022"
      },
      include: ["src/**/*.ts"]
    })
  )
  fs.writeFileSync(filename, source)
  for (const [file, text] of Object.entries(files)) {
    const filePath = path.join(cwd, "src", file)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, text)
  }
  return { cwd, filename }
}

function createPublicPackageProject(source: string, files: Record<string, string> = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "standard-jsdoc-"))
  const filename = path.join(cwd, "src", "Foo.ts")
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({
      name: "@effect/sample",
      type: "module",
      exports: {
        ".": "./src/index.ts",
        "./*": "./src/*.ts",
        "./internal/*": null
      }
    })
  )
  fs.writeFileSync(filename, source)
  for (
    const [file, text] of Object.entries({
      "index.ts": `export * as Foo from "./Foo.ts"\n`,
      ...files
    })
  ) {
    const filePath = path.join(cwd, "src", file)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, text)
  }
  return { cwd, filename }
}

describe("standard-jsdoc", () => {
  it("parses standard JSDoc with sections, example prose, tags, and see links", () => {
    const result = parseStandardJSDoc(`/**
 * Creates a value.
 *
 * **When to use**
 *
 * Use this when you need a value.
 *
 * **Details**
 *
 * The details can use lists.
 *
 * - One item
 *
 * **Gotchas**
 *
 * Avoid passing invalid input.
 *
 * **Example** (Creating a value)
 *
 * Create the value first.
 *
 * \`\`\`ts
 * const value = makeValue()
 * \`\`\`
 *
 * @deprecated Use otherValue.
 * @see {@link Effect.gen} for sequential workflows.
 * @category constructors
 * @since 1.0.0
 */`)

    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.value.description).toEqual({
        short: "Creates a value.",
        whenToUse: "Use this when you need a value.",
        details: "The details can use lists.\n\n- One item",
        gotchas: "Avoid passing invalid input."
      })
      expect(result.value.examples).toEqual([
        { title: "Creating a value", body: "Create the value first.", code: "const value = makeValue()" }
      ])
    }
  })

  it("parses all public JSDocs in an ESTree program into grouped JSON data", () => {
    const source = `/**
 * Options.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /**
   * A member.
   */
  readonly member: string
}
`
    const member = node(source, "readonly member", "TSPropertySignature", { key: { name: "member" } })
    const declaration = node(source, "export interface Options", "TSInterfaceDeclaration", {
      id: { name: "Options" },
      body: { body: [member] }
    })
    const exportNode = exportNamed(source, "export interface Options", declaration)
    const result = parseStandardJSDocsFromESTree({
      source,
      program: { type: "Program", range: [0, source.length], body: [exportNode] } as never
    })

    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.value.namespaces).toEqual([])
      expect(result.value.declarations).toMatchObject([
        {
          name: "Options",
          bucket: "type",
          description: { short: "Options." },
          tags: { category: "models", since: "1.0.0" },
          members: [{ name: "member", description: { short: "A member." } }]
        }
      ])
    }
  })

  it("parses exported variable declaration names", () => {
    const source = `/**
 * Creates a value.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeValue = () => 1
`
    const declarator = node(source, "makeValue", "VariableDeclarator", {
      id: { type: "Identifier", name: "makeValue" }
    })
    const declaration = node(source, "export const makeValue", "VariableDeclaration", {
      declarations: [declarator]
    })
    const exportNode = exportNamed(source, "export const makeValue", declaration)
    const result = parseStandardJSDocsFromESTree({
      source,
      program: { type: "Program", range: [0, source.length], body: [exportNode] } as never
    })

    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.value.declarations).toMatchObject([
        {
          name: "makeValue",
          bucket: "value",
          description: { short: "Creates a value." },
          tags: { category: "constructors", since: "1.0.0" }
        }
      ])
    }
  })

  it("fails instead of dumping an empty declaration name", () => {
    const source = `/**
 * Creates a value.
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const result = parseStandardJSDocsFromESTree({
      source,
      program: { type: "Program", range: [0, source.length], body: [exportNode] } as never
    })

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.error.diagnostics).toContainEqual({
        code: "missing-name",
        message: "Root declaration name could not be determined"
      })
    }
  })

  it("accepts a documented public value", () => {
    const source = `/**
 * A value.
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors).toHaveLength(0)
  })

  it("reports missing public JSDoc", () => {
    const source = `export const value = 1`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors.map((error) => error.message)).toEqual(["Public JSDoc is required"])
  })

  it("rejects multiple short description paragraphs", () => {
    const source = `/**
 * First paragraph.
 *
 * Second paragraph.
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors.map((error) => error.message)).toContain("JSDoc short description must be one paragraph")
  })

  it("rejects out of order sections", () => {
    const source = `/**
 * A value.
 *
 * **Gotchas**
 *
 * Be careful.
 *
 * **Details**
 *
 * More detail.
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors.map((error) => error.message)).toContain("**Details** is out of order or duplicated")
  })

  it("rejects empty sections", () => {
    const source = `/**
 * A value.
 *
 * **Details**
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors.map((error) => error.message)).toContain("**Details** must have a non-empty body")
  })

  it("rejects extra blank lines at boundaries", () => {
    const source = `/**
 * A value.
 *
 *
 * **Details**
 *
 * More detail.
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors.map((error) => error.message)).toContain("JSDoc sections must be separated by exactly one blank line")
  })

  it("allows example prose before the TypeScript fence", () => {
    const source = `/**
 * A value.
 *
 * **Example** (Usage)
 *
 * Create the value first.
 *
 * \`\`\`ts
 * const value = 1
 * \`\`\`
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors).toHaveLength(0)
  })

  it("rejects duplicate example titles case-insensitively", () => {
    const source = `/**
 * A value.
 *
 * **Example** (Usage)
 *
 * \`\`\`ts
 * const a = 1
 * \`\`\`
 *
 * **Example** (usage)
 *
 * \`\`\`ts
 * const b = 1
 * \`\`\`
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors.map((error) => error.message)).toContain("Duplicate example title: usage")
  })

  it("rejects @example tags", () => {
    const source = `/**
 * A value.
 *
 * @example
 * value
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors.map((error) => error.message)).toContain(
      "@example is not allowed; use a canonical **Example** (Title) section"
    )
  })

  it("rejects loose TypeScript fences", () => {
    const source = `/**
 * A value.
 *
 * \`\`\`ts
 * const value = 1
 * \`\`\`
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors.map((error) => error.message)).toContain("JSDoc short description must be one paragraph")
  })

  it("forbids @category on members and allows optional @since/@default", () => {
    const source = `/**
 * Options.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /**
   * A member.
   *
   * @default none
   * @since 1.1.0
   * @category models
   */
  readonly member: string
}
`
    const member = node(source, "readonly member", "TSPropertySignature")
    const declaration = node(source, "export interface Options", "TSInterfaceDeclaration", { body: { body: [member] } })
    const exportNode = exportNamed(source, "export interface Options", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors.map((error) => error.message)).toContain("@category is not allowed in member JSDoc")
  })

  it("allows missing member docs recursively", () => {
    const source = `/**
 * Options.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /**
   * Outer options.
   */
  readonly outer: {
    readonly inner: string
  }
}
`
    const inner = node(source, "readonly inner", "TSPropertySignature")
    const outer = node(source, "readonly outer", "TSPropertySignature", {
      typeAnnotation: { type: "TSTypeAnnotation", typeAnnotation: { type: "TSTypeLiteral", members: [inner] } }
    })
    const declaration = node(source, "export interface Options", "TSInterfaceDeclaration", { body: { body: [outer] } })
    const exportNode = exportNamed(source, "export interface Options", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors).toHaveLength(0)
  })

  it("ignores @internal declarations and their members", () => {
    const source = `/**
 * @internal
 */
export interface Secret {
  readonly missing: string
}
`
    const missing = node(source, "readonly missing", "TSPropertySignature")
    const declaration = node(source, "export interface Secret", "TSInterfaceDeclaration", { body: { body: [missing] } })
    const exportNode = exportNamed(source, "export interface Secret", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors).toHaveLength(0)
  })

  it("allows category in namespace scope", () => {
    const source = `/**
 * Option namespace.
 *
 * @category namespaces
 * @since 1.0.0
 */
export declare namespace Option {
  /**
   * Extracts the value type.
   *
   * @category models
   * @since 1.0.0
   */
  export type Value<T> = T
}
`
    const valueDeclaration = node(source, "export type Value", "TSTypeAliasDeclaration", {
      id: { name: "Value" },
      typeAnnotation: null
    })
    const valueExport = exportNamed(source, "export type Value", valueDeclaration)
    const namespaceDeclaration = node(source, "export declare namespace Option", "TSModuleDeclaration", {
      id: { type: "Identifier", name: "Option" },
      body: { body: [valueExport] }
    })
    const namespaceExport = exportNamed(source, "export declare namespace Option", namespaceDeclaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: namespaceExport }])
    const result = parseStandardJSDocsFromESTree({
      source,
      program: { type: "Program", range: [0, source.length], body: [namespaceExport] } as never
    })

    expect(errors).toHaveLength(0)
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.value.namespaces).toMatchObject([
        {
          tags: { category: "namespaces", since: "1.0.0" },
          declarations: [{ tags: { category: "models", since: "1.0.0" } }]
        }
      ])
    }
  })

  it("allows nested namespace declarations inside ambient namespaces", () => {
    const source = `/**
 * Outer namespace.
 *
 * @since 1.0.0
 */
export declare namespace Outer {
  /**
   * Inner namespace.
   *
   * @since 1.0.0
   */
  export namespace Inner {
  }
}
`
    const innerDeclaration = node(source, "export namespace Inner", "TSModuleDeclaration", {
      id: { type: "Identifier", name: "Inner" },
      body: { body: [] }
    })
    const innerExport = exportNamed(source, "export namespace Inner", innerDeclaration)
    const outerDeclaration = node(source, "export declare namespace Outer", "TSModuleDeclaration", {
      id: { type: "Identifier", name: "Outer" },
      body: { body: [innerExport] }
    })
    const outerExport = exportNamed(source, "export declare namespace Outer", outerDeclaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: outerExport }])
    const result = parseStandardJSDocsFromESTree({
      source,
      program: { type: "Program", range: [0, source.length], body: [outerExport] } as never
    })

    expect(errors).toHaveLength(0)
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.value.namespaces[0]?.namespaces[0]?.name).toBe("Inner")
    }
  })

  it("requires namespace member exports to be type declarations", () => {
    const source = `/**
 * Option namespace.
 *
 * @since 1.0.0
 */
export declare namespace Option {
  /**
   * A value.
   *
   * @since 1.0.0
   */
  export const value = 1
}
`
    const valueDeclaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const valueExport = exportNamed(source, "export const value", valueDeclaration)
    const namespaceDeclaration = node(source, "export declare namespace Option", "TSModuleDeclaration", {
      body: { body: [valueExport] }
    })
    const namespaceExport = exportNamed(source, "export declare namespace Option", namespaceDeclaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: namespaceExport }])

    expect(errors.map((error) => error.message)).toEqual(["Namespace exports must be type declarations"])
  })

  it("reports unsupported constructs", () => {
    const source = `/**
 * An enum.
 *
 * @category models
 * @since 1.0.0
 */
export enum Status {}

export * from "./barrel"

export {}
`
    const enumDeclaration = node(source, "export enum Status", "TSEnumDeclaration")
    const enumExport = exportNamed(source, "export enum Status", enumDeclaration)
    const exportAll = node(source, "export *", "ExportAllDeclaration")
    const emptyExport = exportNamed(source, "export {}", null)
    const errors = runRuleWithSource(source, [
      { visitor: "ExportNamedDeclaration", node: enumExport },
      { visitor: "ExportAllDeclaration", node: exportAll },
      { visitor: "ExportNamedDeclaration", node: emptyExport }
    ])

    expect(errors.map((error) => error.message)).toEqual([
      "Enums are not allowed",
      "Empty export declarations are not allowed"
    ])
  })

  it("ignores default exports and their malformed JSDoc", () => {
    const source = `/**
 * Bad docs.
 *
 *
 * @category constructors
 */
export default class Service {
  run() {}
}
`
    const run = node(source, "run", "MethodDefinition", { kind: "method" })
    const declaration = node(source, "class Service", "ClassDeclaration", { body: { body: [run] } })
    const defaultExport = node(source, "export default", "ExportDefaultDeclaration", { declaration })
    const errors = runRuleWithSource(source, [{ visitor: "ExportDefaultDeclaration", node: defaultExport }])

    expect(errors).toHaveLength(0)
  })

  it("requires JSDoc on every export specifier", () => {
    const source = `export {
  /**
   * Foo value.
   *
   * @category constructors
   * @since 1.0.0
   */
  foo,
  bar
}
`
    const foo = node(source, "foo,", "ExportSpecifier", {
      local: { name: "foo" },
      exported: { name: "foo" }
    })
    const bar = node(source, "bar", "ExportSpecifier", {
      local: { name: "bar" },
      exported: { name: "bar" }
    })
    const exportNode = exportNamed(source, "export {", null, { specifiers: [foo, bar] })
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }])

    expect(errors.map((error) => error.message)).toEqual(["Public JSDoc is required"])
  })

  it("validates resolved TypeScript JSDoc inline links", () => {
    const source = `export interface Foo {}

/**
 * A value referencing {@link Foo | the Foo API}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const { cwd, filename } = createTypescriptProject(source)
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(
      source,
      [{ visitor: "ExportNamedDeclaration", node: exportNode }],
      [{ tsconfig: "tsconfig.json" }],
      { cwd, filename }
    )

    expect(errors).toHaveLength(0)
  })

  it("reports unresolved TypeScript JSDoc inline links", () => {
    const source = `/**
 * A value referencing {@link Missing}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const { cwd, filename } = createTypescriptProject(source)
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(
      source,
      [{ visitor: "ExportNamedDeclaration", node: exportNode }],
      [{ tsconfig: "tsconfig.json" }],
      { cwd, filename }
    )

    expect(errors.map((error) => error.message)).toEqual(["Unresolved JSDoc inline link: {@link Missing}"])
  })

  it("skips files outside the configured include globs", () => {
    const source = `export const value = 1`
    const declaration = node(source, "export const value", "VariableDeclaration", { declarations: [] })
    const exportNode = exportNamed(source, "export const value", declaration)
    const errors = runRuleWithSource(source, [{ visitor: "ExportNamedDeclaration", node: exportNode }], [{
      include: []
    }])

    expect(errors).toHaveLength(0)
  })

  it("accepts dumped files that have barrel and direct module imports", () => {
    const source = `/**
 * A value.
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const { cwd, filename } = createPublicPackageProject(source)
    const declarator = node(source, "value", "VariableDeclarator", {
      id: { type: "Identifier", name: "value" }
    })
    const declaration = node(source, "export const value", "VariableDeclaration", {
      declarations: [declarator]
    })
    const exportNode = exportNamed(source, "export const value", declaration)
    const program = { type: "Program", range: [0, source.length], body: [exportNode] } as TestNode
    const errors = runRuleWithSource(
      source,
      [
        { visitor: "Program", node: program },
        { visitor: "ExportNamedDeclaration", node: exportNode },
        { visitor: "Program:exit", node: program }
      ],
      [],
      { cwd, filename }
    )

    expect(errors).toHaveLength(0)
  })

  it("accepts dumped files that have flat barrel exports", () => {
    const source = `/**
 * A value.
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const { cwd, filename } = createPublicPackageProject(source, {
      "index.ts": `export * from "./Foo.ts"\n`
    })
    const declarator = node(source, "value", "VariableDeclarator", {
      id: { type: "Identifier", name: "value" }
    })
    const declaration = node(source, "export const value", "VariableDeclaration", {
      declarations: [declarator]
    })
    const exportNode = exportNamed(source, "export const value", declaration)
    const program = { type: "Program", range: [0, source.length], body: [exportNode] } as TestNode
    const errors = runRuleWithSource(
      source,
      [
        { visitor: "Program", node: program },
        { visitor: "ExportNamedDeclaration", node: exportNode },
        { visitor: "Program:exit", node: program }
      ],
      [],
      { cwd, filename }
    )

    expect(errors).toHaveLength(0)
  })

  it("accepts dumped files that only have direct module imports", () => {
    const source = `/**
 * A value.
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const { cwd, filename } = createPublicPackageProject(source, {
      "index.ts": `export * from "external"\n`
    })
    const declarator = node(source, "value", "VariableDeclarator", {
      id: { type: "Identifier", name: "value" }
    })
    const declaration = node(source, "export const value", "VariableDeclaration", {
      declarations: [declarator]
    })
    const exportNode = exportNamed(source, "export const value", declaration)
    const program = { type: "Program", range: [0, source.length], body: [exportNode] } as TestNode
    const errors = runRuleWithSource(
      source,
      [
        { visitor: "Program", node: program },
        { visitor: "ExportNamedDeclaration", node: exportNode },
        { visitor: "Program:exit", node: program }
      ],
      [],
      { cwd, filename }
    )

    expect(errors).toHaveLength(0)
  })

  it("reports included files that are not public package subpaths", () => {
    const source = `/**
 * A value.
 *
 * @category constructors
 * @since 1.0.0
 */
export const value = 1
`
    const { cwd, filename } = createPublicPackageProject(source)
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "@effect/sample",
        type: "module",
        exports: {
          ".": "./src/index.ts"
        }
      })
    )
    const declarator = node(source, "value", "VariableDeclarator", {
      id: { type: "Identifier", name: "value" }
    })
    const declaration = node(source, "export const value", "VariableDeclaration", {
      declarations: [declarator]
    })
    const exportNode = exportNamed(source, "export const value", declaration)
    const program = { type: "Program", range: [0, source.length], body: [exportNode] } as TestNode
    const errors = runRuleWithSource(
      source,
      [
        { visitor: "Program", node: program },
        { visitor: "ExportNamedDeclaration", node: exportNode },
        { visitor: "Program:exit", node: program }
      ],
      [],
      { cwd, filename }
    )

    expect(errors.map((error) => error.message)).toEqual([
      `Unable to resolve standard-jsdoc imports: package.json exports do not expose @effect/sample/Foo for src/Foo.ts. Add the missing barrel/package export or exclude this file from standard-jsdoc.`
    ])
  })
})
