import { z } from "zod";
import { createTool } from "@inngest/agent-kit";
import { hybridSearch } from "@/lib/hybrid-search";

interface SearchCodebaseToolOptions {
  projectId: string;
}

export const createSearchCodebaseTool = ({
  projectId,
}: SearchCodebaseToolOptions) => {
  return createTool({
    name: "searchCodebase",
    description:
      "Hybrid semantic + graph search. Finds relevant code using vector similarity, then expands via symbol graph (imports, calls, references). Returns ranked results with context.",
    parameters: z.object({
      query: z.string().describe("Search query describing the code you need"),
      limit: z.number().optional().describe("Max results to return (default: 10)"),
    }),
    handler: async ({ query, limit = 10 }) => {
      try {
        const results = await hybridSearch(projectId, query, limit);

        return JSON.stringify(
          results.map((r) => ({
            file: r.path,
            lines: `${r.startLine}-${r.endLine}`,
            symbol: r.symbolName,
            type: r.symbolType,
            content: r.content.slice(0, 800),
            score: Number(r.score.toFixed(3)),
            retrieval: r.retrievalType,
          })),
          null,
          2
        );
      } catch (error) {
        return `Error performing hybrid search: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  });
};
