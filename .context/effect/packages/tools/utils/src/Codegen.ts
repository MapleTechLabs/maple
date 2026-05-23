/**
 * Barrel file discovery and export generation for Effect development tools.
 *
 * This module provides the `BarrelGenerator` service used by the codegen CLI to
 * find files annotated with `@barrel` comments and rewrite the generated export
 * section beneath each annotation. The generator resolves matching modules
 * relative to each annotated barrel file, preserves the discovered modules'
 * leading JSDoc blocks in the generated output, and normalizes export paths so
 * the produced TypeScript is stable across platforms.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { PlatformError } from "effect/PlatformError"
import * as Glob from "./Glob.ts"

const findAnnotation = (content: string): { pattern: string; offset: number } | undefined => {
  const lines = content.split("\n")

  // Find the line containing the annotation
  let annotationLine = -1
  let pattern: string | undefined
  for (let i = 0; i < lines.length; i++) {
    pattern = parseAnnotation(lines[i])
    if (pattern !== undefined) {
      annotationLine = i
      break
    }
  }

  if (annotationLine === -1 || pattern === undefined) {
    return undefined
  }

  // Walk forwards to find the end of the comment block
  let commentEnd = annotationLine
  while (commentEnd < lines.length - 1 && lines[commentEnd + 1].trimStart().startsWith("//")) {
    commentEnd++
  }

  return { pattern, offset: commentEnd + 1 }
}

const parseAnnotation = (line: string): string | undefined => {
  const match = line.match(/^\/\/\s*@barrel(?:\((.+?)\))?/)
  if (!match) {
    return undefined
  }
  return match[1] ?? "*.ts"
}

/**
 * Metadata for a barrel file discovered from a `@barrel` annotation, including the file path, glob pattern, and insertion offset for generated exports.
 *
 * @category models
 * @since 4.0.0
 */
export interface BarrelFile {
  readonly path: string
  readonly pattern: string
  readonly offset: number
}

/**
 * Service interface for discovering annotated barrel files and regenerating their export contents.
 *
 * @category models
 * @since 4.0.0
 */
export interface BarrelGenerator {
  readonly discoverFiles: (
    pattern: string,
    cwd: string
  ) => Effect.Effect<Array<BarrelFile>, PlatformError | Glob.GlobError>
  readonly processFile: (file: BarrelFile) => Effect.Effect<void, PlatformError | Glob.GlobError>
}

/**
 * Context service tag for barrel file generation.
 *
 * @category tags
 * @since 4.0.0
 */
export const BarrelGenerator: Context.Service<BarrelGenerator, BarrelGenerator> = Context.Service(
  "@effect/utils/BarrelGenerator"
)

/**
 * Builds the `BarrelGenerator` service, discovering files with `@barrel` annotations and rewriting their generated export sections from matching modules.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<BarrelGenerator, never, FileSystem.FileSystem | Path.Path | Glob.Glob> = Effect.gen(
  function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const glob = yield* Glob.Glob

    // Convert native path separators to POSIX (forward slashes) for import/export statements
    const toPosix = path.sep === "/" ? (file: string) => file : (file: string) => file.split(path.sep).join("/")

    const fileToModuleName = (posix: string): string => {
      const withoutExt = posix.slice(0, -path.extname(posix).length)
      return withoutExt.replace(/\//g, "_")
    }

    const processModule = Effect.fn("processModule")(function*(directory: string, file: string) {
      const fullPath = path.join(directory, file)
      const posixPath = toPosix(file)
      const content = yield* fs.readFileString(fullPath)
      const topComment = content.match(/\/\*\*\n[\s\S]*?\*\//)?.[0] ?? ""
      const moduleName = fileToModuleName(posixPath)
      return `${topComment}\nexport * as ${moduleName} from "./${posixPath}"`
    })

    const discoverFile = Effect.fn("discoverFile")(function*(file: string) {
      const content = yield* fs.readFileString(file)
      const parsed = findAnnotation(content)
      return parsed ? { path: file, ...parsed } : undefined
    })

    const discoverFiles = Effect.fn("discoverFiles")(function*(pattern: string, cwd: string) {
      const indexFiles = yield* glob.glob(pattern, {
        cwd,
        dot: false,
        follow: false,
        nodir: true
      })

      const results = yield* Effect.forEach(indexFiles, (file) => discoverFile(path.join(cwd, file)))
      return results.filter((file) => file !== undefined)
    })

    const processFile = Effect.fn("processFile")(function*(file: BarrelFile) {
      const { offset, pattern } = file
      const directory = path.dirname(file.path)
      const self = path.basename(file.path)

      // Find all matching files relative to the current directory excluding the barrel file itself
      const matchedFiles = yield* glob.glob(pattern, {
        cwd: directory,
        dot: false,
        follow: false,
        nodir: true,
        ignore: [self]
      }).pipe(Effect.map((files) => files.sort((a, b) => a.localeCompare(b))))

      const moduleContents = yield* Effect.forEach(matchedFiles, (file) => processModule(directory, file))
      const content = yield* fs.readFileString(file.path)
      const lines = content.split("\n")
      const header = lines.slice(0, offset).join("\n")
      const generated = moduleContents.join("\n\n")

      yield* fs.writeFileString(file.path, `${header}\n\n${generated}\n`)
    })

    return { discoverFiles, processFile }
  }
).pipe(Layer.effect(BarrelGenerator), Layer.provide(Glob.layer))
