import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  projects: defineTable({
    name: v.string(),
    ownerId: v.string(),
    description: v.optional(v.string()),
    updatedAt: v.number(),
    importStatus: v.optional(
      v.union(
        v.literal("importing"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
    exportStatus: v.optional(
      v.union(
        v.literal("exporting"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("cancelled"),
      ),
    ),
    exportRepoUrl: v.optional(v.string()),
    settings: v.optional(
      v.object({
        installCommand: v.optional(v.string()),
        devCommand: v.optional(v.string()),
        buildCommand: v.optional(v.string()),
        testCommand: v.optional(v.string()),
      }),
    ),

    indexingStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("indexing"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
  }).index("by_owner", ["ownerId"]),

  files: defineTable({
    projectId: v.id("projects"),
    parentId: v.optional(v.id("files")),
    name: v.string(),
    language: v.optional(v.string()),
    type: v.union(v.literal("file"), v.literal("folder")),
    content: v.optional(v.string()), // Text files only
    storageId: v.optional(v.id("_storage")),
    size: v.optional(v.number()),
    checksum: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_parent", ["parentId"])
    .index("by_project_parent", ["projectId", "parentId"]),

  conversations: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    updatedAt: v.number(),
  }).index("by_project", ["projectId"]),

  messages: defineTable({
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
  })
    .index("by_conversation", ["conversationId"])
    .index("by_project_status", ["projectId", "status"]),

  terminalCommands: defineTable({
    projectId: v.id("projects"),
    command: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    output: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_project_created", ["projectId", "createdAt"])
    .index("by_project_status", ["projectId", "status"]),
  commandEvents: defineTable({
    commandId: v.string(),
    projectId: v.id("projects"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    output: v.string(),
    exitCode: v.optional(v.number()),
    createdAt: v.number(), // timestamp to know order
  }).index("by_commandId", ["commandId"]),
  codeChunks: defineTable({
    projectId: v.id("projects"),
    fileId: v.id("files"),

    path: v.string(),

    chunkIndex: v.optional(v.number()),

    content: v.string(),

    startLine: v.number(),
    endLine: v.number(),

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

    exported: v.boolean(),

    hash: v.string(),

    vectorId: v.string(),

    tokenCount: v.optional(v.number()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_file", ["fileId"])
    .index("by_project_file", ["projectId", "fileId"])
    .index("by_symbol", ["projectId", "symbolName"])
    .index("by_vector", ["vectorId"]),
  codeGraphNodes: defineTable({
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

    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_file", ["fileId"])
    .index("by_project_name", ["projectId", "name"]),
  codeGraphEdges: defineTable({
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

    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_from", ["fromNodeId"])
    .index("by_to", ["toNodeId"])
    .index("by_project_from", ["projectId", "fromNodeId"]),
  fileImports: defineTable({
    projectId: v.id("projects"),

    fileId: v.id("files"),

    importedPath: v.string(),

    resolvedFileId: v.optional(v.id("files")),

    createdAt: v.number(),
  })
    .index("by_file", ["fileId"])
    .index("by_project", ["projectId"]),
  indexJobs: defineTable({
    projectId: v.id("projects"),

    fileId: v.optional(v.id("files")),

    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),

    type: v.union(v.literal("full"), v.literal("incremental")),

    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_status", ["status"]),
  searchCache: defineTable({
    projectId: v.id("projects"),

    query: v.string(),

    resultChunkIds: v.array(v.id("codeChunks")),

    createdAt: v.number(),
  }).index("by_project_query", ["projectId", "query"]),
});
