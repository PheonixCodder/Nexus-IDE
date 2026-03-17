/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import { createTool } from "@inngest/agent-kit";
import { convex } from "@/lib/convex-client";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { AgentNetworkState } from "../types";

interface WaitForCommandOptions {
  projectId: Id<"projects">;
}

interface CommandCompletedEvent {
  commandId: string;
  status: "completed" | "failed";
  output: string;
  exitCode?: number;
}

export const createWaitForCommandTool = ({
  projectId,
}: WaitForCommandOptions) =>
  createTool({
    name: "waitForCommand",
    description:
      "Wait for a previously queued command to complete. This tool handles race conditions and returns output even if the command finished before the wait began.",
    parameters: z.object({
      commandId: z
        .string()
        .optional()
        .describe(
          "Optional: specific command ID to wait for. If omitted, uses the most recent command from runCommand (stored in state).",
        ),
    }),
    handler: async ({ commandId }, { step, network }) => {
      // 1️⃣ Resolve command ID
      let resolvedCommandId: string | null = null;
      if (commandId) {
        resolvedCommandId = commandId;
      } else if (network) {
        resolvedCommandId =
          (network.state.data as any).pendingCommandId || null;
      }

      if (!resolvedCommandId) {
        return `Error: No command to wait for. Provide a commandId or run runCommand first.`;
      }

      // 2️⃣ Check command in DB first
      let command;
      try {
        command = await step?.run(
          `check-command-${resolvedCommandId}`,
          async () => {
            return await convex.query(api.commands.getById, {
              projectId,
              id: resolvedCommandId as Id<"terminalCommands">,
            });
          },
        );
      } catch (err) {
        console.warn(
          `DB check failed for ${resolvedCommandId}, will check events:`,
          err,
        );
      }

      // 3️⃣ If DB shows command completed, use it
      if (
        command &&
        (command.status === "completed" || command.status === "failed")
      ) {
        const lines = (command.output || "").split("\n");
        const tail = lines.slice(-30).join("\n");
        if (network) {
          const netState = network.state.data as any;
          netState.commandCompleted = command.status === "completed";
          netState.pendingCommandId = null;
          netState.commandStartTime = null;
          netState.lastCommandOutput = lines.slice(-50).join("\n");
          if (command.status === "failed") {
            const newEntry = `\n\n--- Command Failed: ${command.command} ---\n${lines.slice(-50).join("\n")}`;
            const combined = (netState.terminalOutput || "") + newEntry;
            // Keep only last 50 lines
            const allLines = combined.split("\n");
            if (allLines.length > 50) {
              netState.terminalOutput = allLines.slice(-50).join("\n");
            } else {
              netState.terminalOutput = combined;
            }
          }
        }
        if (command.status === "completed") {
          return `✅ Command completed successfully.\n\nCommand: ${command.command}\nExit code: 0\n\nLast output (most recent lines):\n${tail || "(no output)"}`;
        } else {
          throw new Error(
            `❌ Command failed.\n\nCommand: ${command.command}\nStatus: failed\n\nOutput (last lines):\n${tail || "(no output)"}`,
          );
        }
      }

      // 4️⃣ Check commandEvents table as buffer (Option A)
      try {
        const events = await step?.run(
          `check-command-events-${resolvedCommandId}`,
          async () => {
            return await convex.query(api.commandEvents.byCommandId, {
              commandId: resolvedCommandId,
            });
          },
        );

        if (events && events.length > 0) {
          const latest = events[events.length - 1];
          if (network) {
            const netState = network.state.data as AgentNetworkState;
            console.log(JSON.stringify(latest))
            console.log(JSON.stringify(netState))
            netState.commandCompleted = latest.status === "completed";
            netState.pendingCommandId = null;
            netState.commandStartTime = null;
            netState.lastCommandOutput = latest.output
              .split("\n")
              .slice(-50)
              .join("\n");
            if (latest.status === "failed") {
              const newEntry = `\n\n--- Command Failed: ${latest.commandId} ---\n${latest.output.split("\n").slice(-50).join("\n")}`;
              const combined = (netState.terminalOutput || "") + newEntry;
              // Keep only last 50 lines
              const allLines = combined.split("\n");
              if (allLines.length > 50) {
                netState.terminalOutput = allLines.slice(-50).join("\n");
              } else {
                netState.terminalOutput = combined;
              }
            }
          }
          const tail = latest.output.split("\n").slice(-30).join("\n");
          if (latest.status === "completed") {
            return `✅ Command completed successfully.\n\nCommand ID: ${latest.commandId}\nExit code: ${latest.exitCode ?? 0}\n\nLast output (most recent lines):\n${tail || "(no output)"}`;
          } else {
            throw new Error(
              `❌ Command failed.\n\nCommand ID: ${latest.commandId}\nStatus: failed\n\nOutput (last lines):\n${tail || "(no output)"}`,
            );
          }
        }
      } catch (err) {
        console.warn(
          `Event buffer check failed for ${resolvedCommandId}:`,
          err,
        );
      }

      // 5️⃣ Fallback: wait for event
      const event = await step?.waitForEvent(
        `wait-for-command-${resolvedCommandId}`,
        {
          event: "terminal/command.completed",
          timeout: "10m",
          if: `event.data.commandId == '${resolvedCommandId}'`,
        },
      );
      const eventData = event?.data as CommandCompletedEvent;

      if (!eventData) {
        throw new Error(
          `❌ Timeout waiting for command ${resolvedCommandId} to complete.`,
        );
      }

      // 6️⃣ Update network state
      if (network) {
        const netState = network.state.data as any;
        netState.commandCompleted = eventData.status === "completed";
        netState.pendingCommandId = null;
        netState.commandStartTime = null;
        netState.lastCommandOutput = eventData.output
          .split("\n")
          .slice(-50)
          .join("\n");
        if (eventData.status === "failed") {
          const newEntry = `\n\n--- Command Failed: ${eventData.commandId} ---\n${eventData.output.split("\n").slice(-50).join("\n")}`;
          const combined = (netState.terminalOutput || "") + newEntry;
          // Keep only last 50 lines
          const allLines = combined.split("\n");
          if (allLines.length > 50) {
            netState.terminalOutput = allLines.slice(-50).join("\n");
          } else {
            netState.terminalOutput = combined;
          }
        }
      }

      const tail = eventData.output.split("\n").slice(-30).join("\n");
      if (eventData.status === "completed") {
        return `✅ Command completed successfully.\n\nCommand ID: ${eventData.commandId}\nExit code: ${eventData.exitCode ?? 0}\n\nLast output (most recent lines):\n${tail || "(no output)"}`;
      } else {
        throw new Error(
          `❌ Command failed.\n\nCommand ID: ${eventData.commandId}\nStatus: failed\n\nOutput (last lines):\n${tail || "(no output)"}`,
        );
      }
    },
  });
