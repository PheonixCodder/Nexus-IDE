import { v } from "convex/values";

import { action, internalQuery, mutation, query } from "./_generated/server";
import { inngest } from "../inngest/client";
import { getQdrantClient } from "../lib/qdrant-client";
import { api, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

const validateInternalKey = (key: string) => {
  const internalKey = process.env.NEXUS_CONVEX_INTERNAL_KEY;

  if (!internalKey) {
    throw new Error("NEXUS_CONVEX_INTERNAL_KEY is not configured");
  }

  if (key !== internalKey) {
    throw new Error("Invalid internal key");
  }
};

export const getConversationById = query({
  args: {
    conversationId: v.id("conversations"),
    internalKey: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db.get(args.conversationId);
  },
});

export const createMessage = mutation({
  args: {
    internalKey: v.string(),
    conversationId: v.id("conversations"),
    projectId: v.id("projects"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    status: v.optional(
      v.union(
        v.literal("processing"),
        v.literal("completed"),
        v.literal("cancelled"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const messageId = await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      projectId: args.projectId,
      role: args.role,
      content: args.content,
      status: args.status,
    });

    // Update conversation's updatedAt
    await ctx.db.patch(args.conversationId, {
      updatedAt: Date.now(),
    });

    return messageId;
  },
});

export const updateMessageContent = mutation({
  args: {
    internalKey: v.string(),
    messageId: v.id("messages"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch(args.messageId, {
      content: args.content,
      status: "completed" as const,
    });
  },
});

export const updateMessageStatus = mutation({
  args: {
    internalKey: v.string(),
    messageId: v.id("messages"),
    status: v.union(
      v.literal("processing"),
      v.literal("completed"),
      v.literal("cancelled"),
    ),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch(args.messageId, {
      status: args.status,
    });
  },
});

export const getProcessingMessages = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("messages")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "processing"),
      )
      .collect();
  },
});

// Used for Agent conversation context
export const getRecentMessages = query({
  args: {
    internalKey: v.string(),
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("asc")
      .collect();

    const limit = args.limit ?? 10;
    return messages.slice(-limit);
  },
});

// Used for Agent to update conversation title
export const updateConversationTitle = mutation({
  args: {
    internalKey: v.string(),
    conversationId: v.id("conversations"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch(args.conversationId, {
      title: args.title,
      updatedAt: Date.now(),
    });
  },
});

// Used for Agent "ListFiles" tool
export const getProjectFiles = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

// Used for Agent "ReadFiles" tool
export const getFileById = query({
  args: {
    internalKey: v.string(),
    fileId: v.id("files"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db.get(args.fileId);
  },
});

// Used for Agent "UpdateFile" tool
export const updateFile = mutation({
  args: {
    internalKey: v.string(),
    fileId: v.id("files"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const file = await ctx.db.get(args.fileId);

    if (!file) {
      throw new Error("File not found");
    }

    await ctx.db.patch(args.fileId, {
      content: args.content,
      updatedAt: Date.now(),
    });

    // Emit event for re-indexing
    try {
      await inngest.send({
        name: "file.updated",
        data: { projectId: file.projectId, fileId: args.fileId },
      });
    } catch (e) {
      console.error("Failed to send file.updated event:", e);
    }

    return args.fileId;
  },
});

// Used for Agent "CreateFile" tool
export const createFile = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    name: v.string(),
    content: v.string(),
    parentId: v.optional(v.id("files")),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const files = await ctx.db
      .query("files")
      .withIndex("by_project_parent", (q) =>
        q.eq("projectId", args.projectId).eq("parentId", args.parentId),
      )
      .collect();

    const existing = files.find(
      (file) => file.name === args.name && file.type === "file",
    );

    if (existing) {
      throw new Error("File already exists");
    }

    const fileId = await ctx.db.insert("files", {
      projectId: args.projectId,
      name: args.name,
      content: args.content,
      type: "file",
      parentId: args.parentId,
      updatedAt: Date.now(),
    });

    // Emit event for indexing
    try {
      await inngest.send({
        name: "file.updated",
        data: { projectId: args.projectId, fileId },
      });
    } catch (e) {
      console.error("Failed to send file.updated event:", e);
    }

    return fileId;
  },
});

// Used for Agent bulk "CreateFiles" tool
export const createFiles = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    parentId: v.optional(v.id("files")),
    files: v.array(
      v.object({
        name: v.string(),
        content: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const existingFiles = await ctx.db
      .query("files")
      .withIndex("by_project_parent", (q) =>
        q.eq("projectId", args.projectId).eq("parentId", args.parentId),
      )
      .collect();

    const results: { name: string; fileId: string; error?: string }[] = [];

    for (const file of args.files) {
      const existing = existingFiles.find(
        (f) => f.name === file.name && f.type === "file",
      );

      if (existing) {
        results.push({
          name: file.name,
          fileId: existing._id,
          error: "File already exists",
        });
        continue;
      }

      const fileId = await ctx.db.insert("files", {
        projectId: args.projectId,
        name: file.name,
        content: file.content,
        type: "file",
        parentId: args.parentId,
        updatedAt: Date.now(),
      });

      // Emit event for indexing
      try {
        await inngest.send({
          name: "file.updated",
          data: { projectId: args.projectId, fileId },
        });
      } catch (e) {
        console.error("Failed to send file.updated event:", e);
      }

      results.push({ name: file.name, fileId });
    }

    return results;
  },
});

// Used for Agent "CreateFolder" tool
export const createFolder = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    name: v.string(),
    parentId: v.optional(v.id("files")),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const files = await ctx.db
      .query("files")
      .withIndex("by_project_parent", (q) =>
        q.eq("projectId", args.projectId).eq("parentId", args.parentId),
      )
      .collect();

    const existing = files.find(
      (file) => file.name === args.name && file.type === "folder",
    );

    if (existing) {
      throw new Error("Folder already exists");
    }

    const fileId = await ctx.db.insert("files", {
      projectId: args.projectId,
      name: args.name,
      type: "folder",
      parentId: args.parentId,
      updatedAt: Date.now(),
    });

    // Emit event for indexing
    try {
      await inngest.send({
        name: "file.updated",
        data: { projectId: args.projectId, fileId },
      });
    } catch (e) {
      console.error("Failed to send file.updated event:", e);
    }

    return fileId;
  },
});

// Used for Agent "RenameFile" tool
export const renameFile = mutation({
  args: {
    internalKey: v.string(),
    fileId: v.id("files"),
    newName: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const file = await ctx.db.get(args.fileId);
    if (!file) {
      throw new Error("File not found");
    }

    // Check if a file with the new name already exists in the same parent folder
    const siblings = await ctx.db
      .query("files")
      .withIndex("by_project_parent", (q) =>
        q.eq("projectId", file.projectId).eq("parentId", file.parentId),
      )
      .collect();

    const existing = siblings.find(
      (sibling) =>
        sibling.name === args.newName &&
        sibling.type === file.type &&
        sibling._id !== args.fileId,
    );

    if (existing) {
      throw new Error(`A ${file.type} named "${args.newName}" already exists`);
    }

    await ctx.db.patch(args.fileId, {
      name: args.newName,
      updatedAt: Date.now(),
    });

    // Emit event for re-indexing (path changes)
    try {
      await inngest.send({
        name: "file.updated",
        data: { projectId: file.projectId, fileId: args.fileId },
      });
    } catch (e) {
      console.error("Failed to send file.updated event:", e);
    }

    return args.fileId;
  },
});

// Used for Agent "DeleteFile" tool
export const deleteFile = mutation({
  args: {
    internalKey: v.string(),
    fileId: v.id("files"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const file = await ctx.db.get(args.fileId);
    if (!file) {
      throw new Error("File not found");
    }

    // Recursively delete file/folder and all descendants
    const deleteRecursive = async (fileId: typeof args.fileId) => {
      const item = await ctx.db.get(fileId);

      if (!item) {
        return;
      }

      // If it's a folder, delete all children first
      if (item.type === "folder") {
        const children = await ctx.db
          .query("files")
          .withIndex("by_project_parent", (q) =>
            q.eq("projectId", item.projectId).eq("parentId", fileId),
          )
          .collect();

        for (const child of children) {
          await deleteRecursive(child._id);
        }
      }

      // Delete storage file if it exists
      if (item.storageId) {
        await ctx.storage.delete(item.storageId);
      }

      // Delete the file/folder itself
      await ctx.db.delete(fileId);
    };

    const projectIdForEvent = file.projectId; // Capture before deletion

    await deleteRecursive(args.fileId);

    // Emit event for cleanup from index
    try {
      await inngest.send({
        name: "file.deleted",
        data: { projectId: projectIdForEvent, fileId: args.fileId },
      });
    } catch (e) {
      console.error("Failed to send file.deleted event:", e);
    }

    return args.fileId;
  },
});

export const cleanup = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    for (const file of files) {
      // Delete storage file if it exists
      if (file.storageId) {
        await ctx.storage.delete(file.storageId);
      }

      await ctx.db.delete(file._id);
    }

    return { deleted: files.length };
  },
});

export const generateUploadUrl = mutation({
  args: {
    internalKey: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    return await ctx.storage.generateUploadUrl();
  },
});

export const createBinaryFile = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    name: v.string(),
    storageId: v.id("_storage"),
    parentId: v.optional(v.id("files")),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const files = await ctx.db
      .query("files")
      .withIndex("by_project_parent", (q) =>
        q.eq("projectId", args.projectId).eq("parentId", args.parentId),
      )
      .collect();

    const existing = files.find(
      (file) => file.name === args.name && file.type === "file",
    );

    if (existing) {
      throw new Error("File already exists");
    }

    const fileId = await ctx.db.insert("files", {
      projectId: args.projectId,
      name: args.name,
      type: "file",
      storageId: args.storageId,
      parentId: args.parentId,
      updatedAt: Date.now(),
    });

    // Emit event for indexing (binary files may need special handling)
    try {
      await inngest.send({
        name: "file.updated",
        data: { projectId: args.projectId, fileId },
      });
    } catch (e) {
      console.error("Failed to send file.updated event:", e);
    }

    return fileId;
  },
});

export const updateImportStatus = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    status: v.optional(
      v.union(
        v.literal("importing"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch("projects", args.projectId, {
      importStatus: args.status,
      updatedAt: Date.now(),
    });
  },
});

export const updateExportStatus = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    status: v.optional(
      v.union(
        v.literal("exporting"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("cancelled"),
      ),
    ),
    repoUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch("projects", args.projectId, {
      exportStatus: args.status,
      exportRepoUrl: args.repoUrl,
      updatedAt: Date.now(),
    });
  },
});

export const getProjectFilesWithUrls = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    return await Promise.all(
      files.map(async (file) => {
        if (file.storageId) {
          const url = await ctx.storage.getUrl(file.storageId);
          return { ...file, storageUrl: url };
        }
        return { ...file, storageUrl: null };
      }),
    );
  },
});

export const createProject = mutation({
  args: {
    internalKey: v.string(),
    name: v.string(),
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const projectId = await ctx.db.insert("projects", {
      name: args.name,
      ownerId: args.ownerId,
      updatedAt: Date.now(),
      importStatus: "importing",
    });

    return projectId;
  },
});

export const createProjectWithConversation = action({
  args: {
    internalKey: v.string(),
    projectName: v.string(),
    conversationTitle: v.string(),
    ownerId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    projectId: Id<"projects">;
    conversationId: Id<"conversations">;
  }> => {
    // Perform your side-effect logic (validation)
    validateInternalKey(args.internalKey);

    // Call the mutation to perform the DB writes
    const result = await ctx.runMutation(
      api.projects.createProjectAndConversationInternal,
      {
        projectName: args.projectName,
        conversationTitle: args.conversationTitle,
        ownerId: args.ownerId,
      },
    );

    return result;
  },
});

export const createChunk = mutation({
  args: {
    projectId: v.id("projects"),
    fileId: v.id("files"),
    path: v.string(),
    content: v.string(),
    startLine: v.number(),
    endLine: v.number(),
    hash: v.string(),
    vectorId: v.string(),
    symbolName: v.optional(v.string()),
    symbolType: v.optional(
      v.union(
        v.literal("function"),
        v.literal("class"),
        v.literal("component"),
        v.literal("hook"),
        v.literal("method"),
        v.literal("variable"),
      ),
    ),
  },

  handler: async (ctx, args) => {
    return ctx.db.insert("codeChunks", {
      ...args,
      exported: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const createGraphNode = mutation({
  args: {
    projectId: v.id("projects"),
    fileId: v.id("files"),
    path: v.string(),
    name: v.string(),
    type: v.optional(
      v.union(
        v.literal("function"),
        v.literal("class"),
        v.literal("component"),
        v.literal("hook"),
        v.literal("method"),
        v.literal("interface"),
        v.literal("type"),
        v.literal("variable"),
      ),
    ),
    signature: v.optional(v.string()),
    exported: v.boolean(),
    startLine: v.number(),
    endLine: v.number(),
  },

  handler: async (ctx, args) => {
    return ctx.db.insert("codeGraphNodes", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const createGraphEdge = mutation({
  args: {
    projectId: v.id("projects"),
    fromNodeId: v.id("codeGraphNodes"),
    toNodeId: v.id("codeGraphNodes"),
    relation: v.union(
      v.literal("calls"),
      v.literal("imports"),
      v.literal("renders"),
      v.literal("uses"),
      v.literal("extends"),
      v.literal("implements"),
      v.literal("dependsOn"),
    ),
  },

  handler: async (ctx, args) => {
    return ctx.db.insert("codeGraphEdges", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const getChunkByHash = query({
  args: {
    fileId: v.id("files"),
    hash: v.string(),
  },

  handler: async (ctx, { fileId, hash }) => {
    const chunk = await ctx.db
      .query("codeChunks")
      .withIndex("by_file", (q) => q.eq("fileId", fileId))
      .filter((q) => q.eq(q.field("hash"), hash))
      .first();

    return chunk ?? null;
  },
});

export const getChunkForDeletion = internalQuery({
  args: { chunkId: v.id("codeChunks") },
  handler: async (ctx, args) => {
    const chunk = await ctx.db.get(args.chunkId);
    if (!chunk) return null;
    return { vectorId: chunk.vectorId }; // Return the ID stored in the DB
  },
});

export const deleteChunkAndVector = action({
  args: { chunkId: v.id("codeChunks"), internalKey: v.string() },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    // 1. Fetch the vectorId from the DB using the internal query
    const chunk = await ctx.runQuery(internal.system.getChunkForDeletion, {
      chunkId: args.chunkId,
    });

    if (!chunk) throw new Error("Chunk not found in database");

    // 2. Delete from Qdrant using the vectorId we just fetched
    try {
      const qdrant = getQdrantClient();

      await qdrant.delete("codebase", {
        points: [chunk.vectorId],
      });
    } catch (e) {
      console.error("Qdrant deletion failed:", e);
      // Decide if you want to throw here or continue to DB deletion
    }

    // 3. Finally, delete the record from Convex
    await ctx.runMutation(internal.system.deleteChunkRecord, {
      chunkId: args.chunkId,
    });

    return { success: true };
  },
});

export const deleteChunkRecord = internalMutation({
  args: { chunkId: v.id("codeChunks") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.chunkId);
  },
});

// Get all graph nodes for a file
export const getNodesByFile = query({
  args: {
    internalKey: v.string(),
    fileId: v.id("files"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("codeGraphNodes")
      .withIndex("by_file", (q) => q.eq("fileId", args.fileId))
      .collect();
  },
});

// Get edges by from node (for cleanup)
export const getEdgesByNode = query({
  args: {
    internalKey: v.string(),
    nodeId: v.id("codeGraphNodes"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("codeGraphEdges")
      .withIndex("by_from", (q) => q.eq("fromNodeId", args.nodeId))
      .collect();
  },
});

// Delete graph edge
export const deleteGraphEdge = mutation({
  args: {
    internalKey: v.string(),
    edgeId: v.id("codeGraphEdges"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    await ctx.db.delete(args.edgeId);
  },
});

// Delete graph node
export const deleteGraphNode = mutation({
  args: {
    internalKey: v.string(),
    nodeId: v.id("codeGraphNodes"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    await ctx.db.delete(args.nodeId);
  },
});

// ========== GRAPH QUERIES FOR HYBRID RETRIEVAL ==========

// Get graph nodes by symbol name (for symbol lookup)
export const getNodesBySymbol = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    symbolName: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    // Search for exact matches first using the by_project_name index
    const exactMatches = await ctx.db
      .query("codeGraphNodes")
      .withIndex("by_project_name", (q) =>
        q.eq("projectId", args.projectId).eq("name", args.symbolName),
      )
      .collect();

    // If no exact matches, try partial matches (prefix) - Convex doesn't support LIKE,
    // so we'll also check by symbol field if it's populated
    // For now, return exact matches
    return exactMatches;
  },
});

// Get graph edges by target node (incoming edges)
export const getEdgesByTarget = query({
  args: {
    internalKey: v.string(),
    nodeId: v.id("codeGraphNodes"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("codeGraphEdges")
      .withIndex("by_to", (q) => q.eq("toNodeId", args.nodeId))
      .collect();
  },
});

// Get graph edges by project and from node (more efficient than getEdgesByNode for specific node)
export const getOutgoingEdges = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    fromNodeId: v.id("codeGraphNodes"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("codeGraphEdges")
      .withIndex("by_project_from", (q) =>
        q.eq("projectId", args.projectId).eq("fromNodeId", args.fromNodeId),
      )
      .collect();
  },
});

// Get chunks for a file (used in graph expansion)
export const getChunksByFile = query({
  args: {
    internalKey: v.string(),
    fileId: v.id("files"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("codeChunks")
      .withIndex("by_file", (q) => q.eq("fileId", args.fileId))
      .collect();
  },
});

// Get graph node by ID
export const getNodeById = query({
  args: {
    internalKey: v.string(),
    nodeId: v.id("codeGraphNodes"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    return await ctx.db.get(args.nodeId);
  },
});

// Get all project chunks (for deduplication)
export const getChunksByProject = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("codeChunks")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

export const getEdgesForNode = query({
  args: {
    internalKey: v.string(),
    nodeId: v.id("codeGraphNodes"),
  },

  handler: async (ctx, args) => {
    if (args.internalKey !== process.env.NEXUS_CONVEX_INTERNAL_KEY) {
      throw new Error("Unauthorized");
    }

    // outgoing edges
    const outgoing = await ctx.db
      .query("codeGraphEdges")
      .withIndex("by_from", (q) => q.eq("fromNodeId", args.nodeId))
      .collect();

    // incoming edges
    const incoming = await ctx.db
      .query("codeGraphEdges")
      .withIndex("by_to", (q) => q.eq("toNodeId", args.nodeId))
      .collect();

    return [...outgoing, ...incoming];
  },
});

export const getChunksByNodeIds = query({
  args: {
    internalKey: v.string(),
    nodeIds: v.array(v.id("codeGraphNodes")),
  },

  handler: async (ctx, args) => {
    if (args.internalKey !== process.env.NEXUS_CONVEX_INTERNAL_KEY) {
      throw new Error("Unauthorized");
    }

    if (!args.nodeIds.length) return [];

    // fetch nodes
    const nodes = await Promise.all(args.nodeIds.map((id) => ctx.db.get(id)));

    const validNodes = nodes.filter(Boolean);

    const fileIds = [...new Set(validNodes.map((n) => n!.fileId))];

    if (!fileIds.length) return [];

    // fetch chunks for those files
    const chunkResults = await Promise.all(
      fileIds.map((fileId) =>
        ctx.db
          .query("codeChunks")
          .withIndex("by_file", (q) => q.eq("fileId", fileId))
          .collect(),
      ),
    );

    return chunkResults.flat();
  },
});
