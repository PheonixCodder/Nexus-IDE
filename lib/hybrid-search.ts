import { embedChunk } from "./embed";
import { getQdrantClient } from "./qdrant-client";
import { convex } from "./convex-client";
import { api } from "../convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

export interface HybridSearchResult {
  chunkId: string;
  fileId: string;
  path: string;
  content: string;
  startLine: number;
  endLine: number;

  symbolName?: string;
  symbolType?: string;

  score: number;
  vectorScore: number;
  graphBoost: number;

  retrievalType: "vector" | "graph" | "both";
}

export async function hybridSearch(
  projectId: string,
  query: string,
  limit = 12,
): Promise<HybridSearchResult[]> {
  const embedding = await embedChunk(query);
  const qdrant = getQdrantClient();

  // 1️⃣ VECTOR SEARCH
  const vectorHits = await qdrant.search("codebase", {
    vector: embedding,
    limit: 20,
    with_payload: true,
    filter: {
      must: [
        {
          key: "projectId",
          match: { value: projectId },
        },
      ],
    },
  });

  if (!vectorHits.length) return [];

  const vectorResults: HybridSearchResult[] = vectorHits.map((hit) => ({
    chunkId: String(hit.id),
    fileId: hit.payload?.fileId as string,
    path: hit.payload?.path as string,
    content: (hit.payload?.content as string) ?? "",
    startLine: (hit.payload?.startLine as number) ?? 0,
    endLine: (hit.payload?.endLine as number) ?? 0,
    symbolName: hit.payload?.symbolName as string,
    symbolType: hit.payload?.symbolType as string,
    vectorScore: (hit.score as number) ?? 0,
    graphBoost: 0,
    score: hit.score ?? 0,
    retrievalType: "vector",
  }));

  // 2️⃣ COLLECT SYMBOLS
  const symbolNames = [
    ...new Set(
      vectorResults
        .slice(0, 8)
        .map((r) => r.symbolName)
        .filter(Boolean),
    ),
  ];

  if (!symbolNames.length) {
    return vectorResults.slice(0, limit);
  }

  // 3️⃣ GET GRAPH NODES
  const nodes = await Promise.all(
    symbolNames.map((symbol) =>
      convex.query(api.system.getNodesBySymbol, {
        internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
        projectId: projectId as Id<"projects">,
        symbolName: symbol!,
      }),
    ),
  );

  const flatNodes = nodes.flat();

  if (!flatNodes.length) {
    return vectorResults.slice(0, limit);
  }

  // 4️⃣ FETCH NEIGHBOR EDGES (parallel)
  const edgeQueries = flatNodes.map((node) =>
    convex.query(api.system.getEdgesForNode, {
      internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
      nodeId: node._id,
    }),
  );

  const edgeResults = (await Promise.all(edgeQueries)).flat();

  const neighborNodeIds = new Set<string>();

  edgeResults.forEach((edge) => {
    neighborNodeIds.add(edge.fromNodeId);
    neighborNodeIds.add(edge.toNodeId);
  });

  if (!neighborNodeIds.size) {
    return vectorResults.slice(0, limit);
  }

  // 5️⃣ FETCH NEIGHBOR FILE CHUNKS (BATCH)
  const neighborChunks = await convex.query(api.system.getChunksByNodeIds, {
    internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
    nodeIds: Array.from(neighborNodeIds as Set<Id<"codeGraphNodes">>),
  });

  const graphResults: HybridSearchResult[] = neighborChunks.map((chunk) => ({
    chunkId: chunk._id,
    fileId: chunk.fileId,
    path: chunk.path,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    symbolName: chunk.symbolName,
    symbolType: chunk.symbolType,
    vectorScore: 0,
    graphBoost: 0.35,
    score: 0.35,
    retrievalType: "graph",
  }));

  // 6️⃣ MERGE RESULTS
  const map = new Map<string, HybridSearchResult>();

  for (const r of vectorResults) map.set(r.chunkId, r);

  for (const g of graphResults) {
    const existing = map.get(g.chunkId);

    if (!existing) {
      map.set(g.chunkId, g);
      continue;
    }

    existing.graphBoost += g.graphBoost;
    existing.retrievalType = "both";
  }

  const merged = Array.from(map.values());

  // 7️⃣ FINAL SCORING
  for (const r of merged) {
    r.score = 0.75 * r.vectorScore + 0.25 * Math.min(r.graphBoost, 1);
  }

  merged.sort((a, b) => b.score - a.score);

  return merged.slice(0, limit);
}
