import { createTool } from "@inngest/agent-kit";
import { api } from "@/convex/_generated/api";
import { convex } from "@/lib/convex-client";
import z from "zod";
import { Id } from "@/convex/_generated/dataModel";

export const createReadTerminalLogsTool = ({
  projectId,
}: {
  projectId: Id<"projects">;
}) =>
  createTool({
    name: "readTerminalLogs",
    description:
      "Read recent terminal output. Prefer waitForCommand for command completion. Use this only for checking status without waiting or viewing recent history.",

    parameters: z.object({
      commandId: z
        .string()
        .optional()
        .describe("Optional: get logs for a specific command ID"),
      limit: z.number().optional().default(3),
    }),

    handler: async ({ commandId, limit = 3 }, { step }) => {
      return step?.run("read-terminal-logs", async () => {
        // If specific command ID requested, get that command's output (truncated)
        if (commandId) {
          const cmd = await convex.query(api.commands.getById, {
            projectId,
            id: commandId as Id<"terminalCommands">,
          });
          if (!cmd) return `Command ${commandId} not found.`;
          return `Command: ${cmd.command}\nStatus: ${cmd.status}\n\nOutput:\n${cmd.output ?? "(no output)"}`;
        }

        // Get recent logs
        const logs = await convex.query(api.commands.getRecentLogs, {
          projectId,
          limit,
        });

        if (!logs?.length) return "No terminal output yet.";

        // For each log, ensure output is truncated
        const truncatedLogs = logs.map((l) => {
          let output = l.output ?? "";
          // Limit to 50 lines per log entry to avoid massive context
          const lines = output.split("\n");
          if (lines.length > 50) {
            output =
              lines.slice(-50).join("\n") +
              `\n[... truncated from ${lines.length} lines total]`;
          }
          return {
            command: l.command,
            status: l.status,
            output,
          };
        });

        return truncatedLogs
          .map(
            (l) =>
              `Command: ${l.command}\nStatus: ${l.status}\n\nOutput:\n${l.output}`,
          )
          .join("\n\n");
      });
    },
  });
