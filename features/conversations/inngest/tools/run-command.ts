/* eslint-disable @typescript-eslint/no-explicit-any */
import { Id } from "@/convex/_generated/dataModel";
import { createTool } from "@inngest/agent-kit";
import z from "zod";
import { api } from "@/convex/_generated/api";
import { convex } from "@/lib/convex-client";

export const createRunCommandTool = ({
  projectId,
}: {
  projectId: Id<"projects">;
}) => {
  return createTool({
    name: "runCommand",
    description:
      "Execute a shell command in the project's WebContainer environment. Returns a commandId for tracking. Use waitForCommand to wait for completion.",
    parameters: z.object({
      command: z
        .string()
        .describe(
          "Command like npm install or npm run dev or npx create-next-app@latest",
        ),
    }),
    handler: async ({ command }, { step, network }) => {
      return await step?.run("queue-command", async () => {
        // Check if there's already a pending/running command that hasn't been waited on
        if (network) {
          const netState = network.state.data as any;
          const pendingId = netState.pendingCommandId;
          const completed = netState.commandCompleted;

          if (pendingId && !completed) {
            return {
              message: `A command is already running (ID: ${pendingId}). Wait for it to complete.`,
              commandId: pendingId,
              status: "queued",
            };
          }
        }

        const commandId = await convex.mutation(api.commands.enqueue, {
          projectId,
          command,
        });

        // Store command ID in network state for waitForCommand
        if (network) {
          const netState = network.state.data as any;
          netState.pendingCommandId = commandId;
          netState.commandStartTime = Date.now();
          netState.commandCompleted = false;
        }

        return {
          message: `Queued command: ${command}`,
          commandId: commandId,
          status: "queued",
        };
      });
    },
  });
};
