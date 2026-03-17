import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const enqueue = mutation({
  args: {
    projectId: v.id("projects"),
    command: v.string(),
  },

  handler: async (ctx, args) => {
    // Check for duplicate pending/running command within last 30 seconds
    const recent = await ctx.db
      .query("terminalCommands")
      .withIndex("by_project_created", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(10);

    const thirtySecondsAgo = Date.now() - 30000;
    const duplicate = recent.find(
      (c) =>
        c.command === args.command &&
        c.status !== "completed" &&
        c.status !== "failed" &&
        c.createdAt > thirtySecondsAgo,
    );

    if (duplicate) {
      // Return existing command ID instead of creating duplicate
      return duplicate._id;
    }

    // Create new command
    const id = await ctx.db.insert("terminalCommands", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });

    return id;
  },
});

export const getPending = query({
  args: { projectId: v.id("projects") },

  handler: async (ctx, args) => {
    return await ctx.db
      .query("terminalCommands")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "pending"),
      )
      .collect();
  },
});
export const update = mutation({
  args: {
    id: v.id("terminalCommands"),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    output: v.optional(v.string()),
  },

  handler: async (ctx, args) => {
    // 1️⃣ Fetch current command (Atomic Read)
    const cmd = await ctx.db.get(args.id);
    if (!cmd) throw new Error(`Command ${args.id} not found`);

    // 2️⃣ Define allowed transitions
    const allowed: Record<string, string[]> = {
      pending: ["running", "failed"],
      running: ["completed", "failed"],
      completed: [],
      failed: [],
    };

    // 3️⃣ Verify transition logic
    if (!allowed[cmd.status].includes(args.status)) {
      throw new Error(
        `Invalid status transition: ${cmd.status} → ${args.status}`,
      );
    }

    // 4️⃣ Apply the update
    // No "if (existingDoc...)" check needed here because the record
    // is locked to this transaction since the 'get' above.
    await ctx.db.patch(args.id, {
      status: args.status,
      output: args.output,
    });

    return true;
  },
});

export const getRecentLogs = query({
  args: {
    projectId: v.id("projects"),
    limit: v.number(),
  },

  handler: async (ctx, args) => {
    const cmds = await ctx.db
      .query("terminalCommands")
      .withIndex("by_project_created", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(args.limit);

    return cmds.map((c) => ({
      command: c.command,
      status: c.status,
      output: c.output,
    }));
  },
});

export const getById = query({
  args: {
    projectId: v.id("projects"),
    id: v.id("terminalCommands"),
  },
  handler: async (ctx, args) => {
    // Verify the command belongs to the project
    let cmd = await ctx.db.get(args.id);
    if (!cmd || cmd.projectId !== args.projectId) {
      return null;
    }

    // Truncate output to last 100 lines to prevent context bloat
    if (cmd.output) {
      const lines = cmd.output.split("\n");
      if (lines.length > 100) {
        cmd = {
          ...cmd,
          output:
            lines.slice(-100).join("\n") +
            "\n[... output truncated - total lines: " +
            lines.length +
            "]",
        };
      }
    }

    return cmd;
  },
});
