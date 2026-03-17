import crypto from "crypto";

export function createHash(content: string) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function extractChunks(tree: any, source: string) {
  const chunks: any[] = [];

  function walk(node: any) {
    if (
      node.type === "function_declaration" ||
      node.type === "class_declaration" ||
      node.type === "method_definition"
    ) {
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;

      const content = source.slice(node.startIndex, node.endIndex);

      const nameNode = node.childForFieldName("name");

      chunks.push({
        content,
        startLine,
        endLine,
        symbolName: nameNode?.text,
        symbolType: node.type.includes("class") ? "class" : "function",
        path: nameNode?.text ?? "anonymous",
      });
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree.rootNode);

  return chunks;
}


export function extractSymbols(tree: any, source: string) {
  const symbols: any[] = [];

  function walk(node: any) {
    if (
      node.type === "function_declaration" ||
      node.type === "class_declaration"
    ) {
      const name = node.childForFieldName("name")?.text;

      symbols.push({
        name,
        type: node.type.includes("class")
          ? "class"
          : "function",
        signature: source.slice(node.startIndex, node.endIndex),
        exported: source.includes(`export ${name}`),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    }

    node.children.forEach(walk);
  }

  walk(tree.rootNode);

  return symbols;
}

export function detectRelations(symbols: any[]) {
  const edges: any[] = [];

  for (const a of symbols) {
    for (const b of symbols) {
      if (a === b) continue;

      if (a.signature.includes(`${b.name}(`)) {
        edges.push({
          fromNodeId: a.id,
          toNodeId: b.id,
          relation: "calls",
        });
      }
    }
  }

  return edges;
}

