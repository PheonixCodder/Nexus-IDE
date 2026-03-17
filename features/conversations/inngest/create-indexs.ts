/* eslint-disable @typescript-eslint/no-explicit-any */
import { Parser, Language } from "web-tree-sitter";
import path from "path";
import crypto from "crypto";

import { getQdrantClient } from "@/lib/qdrant-client";
import { embedChunk } from "@/lib/embed";

import { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";

import { api } from "@/convex/_generated/api";

import {
  extractChunks,
  createHash,
  extractSymbols,
  detectRelations,
} from "@/lib/indexing";

export const indexFile = inngest.createFunction(
  { id: "index-file" },
  { event: "file.updated" },

  async ({ event, step }) => {
    const { projectId, fileId } = event.data;
    const file = await step.run("get-file", async () => {
      return convex.query(api.system.getFileById, {
        fileId,
        internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
      });
    });

    if (!file?.content) return;

    // Compute the full file path by traversing parent chain
    const buildFilePath = async (f: any): Promise<string> => {
      const parts: string[] = [f.name];
      let current = f;
      while (current.parentId) {
        const parent = await convex.query(api.system.getFileById, {
          fileId: current.parentId,
          internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
        });
        if (!parent) break;
        parts.unshift(parent.name);
        current = parent;
      }
      return parts.join("/");
    };

    const qdrant = getQdrantClient();
    const filePath = await buildFilePath(file);

    await Parser.init();
    const parser = new Parser();
    const Lang = await Language.load(
      path.join(process.cwd(), "public/tree-sitter-typescript.wasm"),
    );
    parser.setLanguage(Lang);

    const tree = parser.parse(file.content);

    // Delete existing chunks for this file before re-indexing
    const existingChunks = await step.run("get-existing-chunks", async () => {
      return convex.query(api.system.getChunksByFile, {
        fileId,
        internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
      });
    });

    for (const oldChunk of existingChunks) {
      await step.run("delete-old-chunk", async () => {
        // Delete from Qdrant
        try {
          await qdrant.delete("codebase", { points: [oldChunk.vectorId] });
        } catch (e) {
          console.error("Failed to delete vector from Qdrant:", e);
        }
        // Delete chunk record
        await convex.action(api.system.deleteChunkAndVector, {
          chunkId: oldChunk._id,
          internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
        });
      });
    }

    // Also delete existing graph nodes for this file
    const existingNodes = await step.run("get-existing-nodes", async () => {
      return convex.query(api.system.getNodesByFile, {
        fileId,
        internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
      });
    });

    for (const oldNode of existingNodes) {
      // Delete edges connected to this node
      const edges = await step.run("get-old-edges", async () => {
        return convex.query(api.system.getEdgesByNode, {
          nodeId: oldNode._id,
          internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
        });
      });

      for (const edge of edges) {
        await step.run("delete-old-edge", async () => {
          await convex.mutation(api.system.deleteGraphEdge, {
            edgeId: edge._id,
            internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
          });
        });
      }

      // Delete graph node
      await step.run("delete-old-node", async () => {
        await convex.mutation(api.system.deleteGraphNode, {
          nodeId: oldNode._id,
          internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
        });
      });
    }

    const chunks = extractChunks(tree, file.content);

    for (const chunk of chunks) {
      const hash = createHash(chunk.content);

      // No need to check for existing chunk – we already cleared them

      const embedding = await step.run("embed-chunk", async () => {
        return embedChunk(chunk.content);
      });

      const vectorId = crypto.randomUUID();

      await step.run("qdrant-upsert", async () => {
        await qdrant.upsert("codebase", {
          points: [
            {
              id: vectorId,
              vector: embedding,
              payload: {
                projectId,
                fileId,
                path: filePath,
              },
            },
          ],
        });
      });

      await step.run("create-chunk", async () => {
        return convex.mutation(api.system.createChunk, {
          projectId,
          fileId,
          path: filePath,
          content: chunk.content,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          hash,
          vectorId,
          symbolName: chunk.symbolName,
          symbolType: chunk.symbolType,
        });
      });

      const symbols = extractSymbols(tree, file.content);

      for (const symbol of symbols) {
        await step.run("create-node", async () => {
          return convex.mutation(api.system.createGraphNode, {
            projectId,
            fileId,
            path: filePath,
            name: symbol.name,
            type: symbol.type,
            signature: symbol.signature,
            exported: symbol.exported,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
          });
        });
      }

      const relations = detectRelations(symbols);

      for (const relation of relations) {
        await step.run("create-edge", async () => {
          return convex.mutation(api.system.createGraphEdge, relation);
        });
      }
    }
  },
);

// Handler for file deletions - cleanup index
export const deleteFileIndex = inngest.createFunction(
  { id: "delete-file-index" },
  { event: "file.deleted" },

  async ({ event, step }) => {
    const { projectId, fileId } = event.data;

    const qdrant = getQdrantClient();

    // Get all chunks for this file and remove from Qdrant
    const chunks = await step.run("get-chunks", async () => {
      return convex.query(api.system.getChunksByFile, {
        fileId,
        internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
      });
    });

    for (const chunk of chunks) {
      // Remove from Qdrant
      await step.run("qdrant-delete", async () => {
        await qdrant.delete("codebase", { points: [chunk.vectorId] });
      });

      // Delete chunk record
      await step.run("delete-chunk", async () => {
        await convex.action(api.system.deleteChunkAndVector, {
          chunkId: chunk._id,
          internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
        });
      });
    }

    // Get all graph nodes for this file and remove them
    const nodes = await step.run("get-nodes", async () => {
      return convex.query(api.system.getNodesByFile, {
        fileId,
        internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
      });
    });

    for (const node of nodes) {
      // Delete graph edges connected to this node
      const edges = await step.run("get-edges", async () => {
        return convex.query(api.system.getEdgesByNode, {
          nodeId: node._id,
          internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
        });
      });

      for (const edge of edges) {
        await step.run("delete-edge", async () => {
          await convex.mutation(api.system.deleteGraphEdge, {
            edgeId: edge._id,
            internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
          });
        });
      }

      // Delete graph node
      await step.run("delete-node", async () => {
        await convex.mutation(api.system.deleteGraphNode, {
          nodeId: node._id,
          internalKey: process.env.NEXUS_CONVEX_INTERNAL_KEY!,
        });
      });
    }
  },
);
