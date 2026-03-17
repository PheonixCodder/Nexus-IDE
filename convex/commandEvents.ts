import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const byCommandId = query({
  // 1. Define and validate arguments
  args: {
    commandId: v.string(),
  },
  // 2. Implement the query logic
  handler: async (ctx, args) => {
    return await ctx.db
      .query("commandEvents")
      .filter((q) => q.eq(q.field("commandId"), args.commandId))
      .order("asc") // Sorts by _creationTime by default
      .collect();
  },
});

export const create = mutation({
  args: {
    commandId: v.string(),
    projectId: v.id("projects"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    output: v.string(),
    exitCode: v.optional(v.number()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    const newEvent = await ctx.db.insert("commandEvents", {
      commandId: args.commandId,
      projectId: args.projectId,
      status: args.status,
      output: args.output,
      exitCode: args.exitCode,
      createdAt: args.createdAt,
    });
    return newEvent;
  },
});
