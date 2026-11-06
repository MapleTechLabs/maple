import type { ESTree, SourceCode } from "@oxlint/plugins";

const FILE_BOUNDARY = /\bBOUNDARY-FILE\s*:/u;
const BOUNDARY = /\bBOUNDARY\s*:/u;

/**
 * `BOUNDARY-FILE:` anywhere marks the whole module as a boundary. `BOUNDARY:` exempts only the
 * declaration it is written on (the node or one of its ancestors), never its neighbours.
 */
export function hasBoundaryComment(sourceCode: SourceCode, node: ESTree.Node): boolean {
  if (sourceCode.getAllComments().some((comment) => FILE_BOUNDARY.test(comment.value))) {
    return true;
  }
  let current = node;
  while (current.type !== "Program") {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some((comment) => comment.end <= node.start && BOUNDARY.test(comment.value))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}
