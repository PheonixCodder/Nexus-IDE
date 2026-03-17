/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createAgent,
  openai,
  createNetwork,
  createState,
  Message,
  AgentResult,
} from "@inngest/agent-kit";

import { inngest } from "@/inngest/client";
import { NonRetriableError } from "inngest";
import { convex } from "@/lib/convex-client";
import {
  TITLE_GENERATOR_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  CODING_AGENT_SYSTEM_PROMPT,
  REVIEWER_SYSTEM_PROMPT,
  DEBUGGER_SYSTEM_PROMPT,
} from "./constants";
import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { createListFilesTool } from "./tools/list-files";
import { createReadFilesTool } from "./tools/read-files";
import { createUpdateFileTool } from "./tools/update-file";
import { createCreateFilesTool } from "./tools/create-files";
import { createCreateFolderTool } from "./tools/create-folder";
import { createRenameFileTool } from "./tools/rename-file";
import { createDeleteFilesTool } from "./tools/delete-files";
import { createScrapeUrlsTool } from "./tools/scrape-urls";
import { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { AgentNetworkState } from "./types";
import { createRunCommandTool } from "./tools/run-command";
import { createReadTerminalLogsTool } from "./tools/read-terminal-logs-tool";
import { createLintTool } from "./tools/run-lint-tool";
import { createRunTestsTool } from "./tools/tests";
import { createWaitForCommandTool } from "./tools/wait-for-command";
import { createPatchUpdateTool } from "./tools/patch-files";
import { createSearchCodebaseTool } from "./tools/searchCodebase";

interface MessageEvent {
  messageId: Id<"messages">;
  conversationId: Id<"conversations">;
  projectId: Id<"projects">;
  message: string;
}

// Helper to extract clean text from agent output
const extractText = (output: any): string => {
  const textMessage = output?.find(
    (m: any) => m.type === "text" && m.role === "assistant",
  );
  if (!textMessage) return "";
  return typeof textMessage.content === "string"
    ? textMessage.content
    : textMessage.content.map((c: any) => c.text || "").join("");
};

// Helper to detect if an agent used any tools on its turn
const agentMadeToolCalls = (result: AgentResult): boolean => {
  // AgentResult has a toolCalls array that contains ToolResultMessage[]
  return !!(result && result.toolCalls && result.toolCalls.length > 0);
};

export const processMessage = inngest.createFunction(
  {
    id: "process-message",
    cancelOn: [
      {
        event: "message/cancel",
        if: "event.data.messageId == async.data.messageId",
      },
    ],
    onFailure: async ({ event, step }) => {
      const { messageId } = event.data.event.data as MessageEvent;
      const internalKey = process.env.NEXUS_CONVEX_INTERNAL_KEY;

      if (internalKey) {
        await step.run("update-message-on-failure", async () => {
          await convex.mutation(api.system.updateMessageContent, {
            internalKey,
            messageId,
            content:
              "My apologies, I encountered an error while processing your request. Let me know if you need anything else!",
          });
        });
      }
    },
  },
  { event: "message/sent" },
  async ({ event, step }) => {
    const { messageId, conversationId, projectId, message } =
      event.data as MessageEvent;

    const internalKey = process.env.NEXUS_CONVEX_INTERNAL_KEY;
    if (!internalKey) {
      throw new NonRetriableError(
        "NEXUS_CONVEX_INTERNAL_KEY is not configured",
      );
    }

    await step.sleep("wait-for-db-sync", "1s");

    const conversation = await step.run("get-conversation", async () =>
      convex.query(api.system.getConversationById, {
        internalKey,
        conversationId,
      }),
    );

    if (!conversation) throw new NonRetriableError("Conversation not found");

    const recentMessages = await step.run("get-recent-messages", async () =>
      convex.query(api.system.getRecentMessages, {
        internalKey,
        conversationId,
        limit: 10,
      }),
    );

    // Build base system prompt with conversation history context
    let baseSystemPrompt = CODING_AGENT_SYSTEM_PROMPT;

    // Filter out the current processing message and empty messages
    const contextMessages = recentMessages.filter(
      (msg) => msg._id !== messageId && msg.content.trim() !== "",
    );

    if (contextMessages.length > 0) {
      const historyText = contextMessages
        .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
        .join("\n\n");

      baseSystemPrompt += `\n\n## Previous Conversation (for context only - do NOT repeat these responses):\n${historyText}\n\n## Current Request:\nRespond ONLY to the user's new message below. Do not repeat or reference your previous responses.`;
    }

    // Title generation (first message only)
    if (conversation.title === DEFAULT_CONVERSATION_TITLE) {
      const titleAgent = createAgent({
        name: "title-generator",
        system: TITLE_GENERATOR_SYSTEM_PROMPT,
        model: openai({
          model: "stepfun/step-3.5-flash:free",
          apiKey: process.env.OPENROUTER_API_KEY,
          baseUrl: "https://openrouter.ai/api/v1/",
          defaultParameters: { temperature: 0, max_completion_tokens: 50 },
        }),
      });

      const { output } = await titleAgent.run(message, { step });
      const titleText = extractText(output).trim();
      if (titleText) {
        await step.run("update-conversation-title", async () =>
          convex.mutation(api.system.updateConversationTitle, {
            internalKey,
            conversationId,
            title: titleText,
          }),
        );
      }
    }

    // ============== AGENTS WITH STATE UPDATES ==============
    const plannerAgent = createAgent({
      name: "planner",
      system: PLANNER_SYSTEM_PROMPT,
      model: openai({
        model: "stepfun/step-3.5-flash:free",
        apiKey: process.env.OPENROUTER_API_KEY,
        baseUrl: "https://openrouter.ai/api/v1/",
        defaultParameters: { temperature: 0.3 },
      }),
      lifecycle: {
        onFinish: ({ result, network }) => {
          if (network) {
            const text = extractText(result.output);
            if (!text) {
              throw new Error("Planner returned no text output");
            }

            // Extract JSON from code block or raw
            let jsonText = text;
            const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
              jsonText = jsonMatch[1];
            } else {
              // Fallback: try to find a JSON object in the text
              const start = text.indexOf("{");
              const end = text.lastIndexOf("}") + 1;
              if (start !== -1 && end !== -1 && start < end) {
                jsonText = text.substring(start, end);
              }
            }

            let parsed: any;
            try {
              parsed = JSON.parse(jsonText);
            } catch (e) {
              throw new Error(`Planner produced invalid JSON: ${jsonText}`);
            }

            if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
              throw new Error(`Planner JSON missing tasks array: ${jsonText}`);
            }

            network.state.data.todos = parsed.tasks;
            network.state.data.currentTaskIndex = 0;
          }
          return result;
        },
      },
    });

    const codingAgent = createAgent({
      name: "coder",
      system: ({ network }) => {
        const state = network?.state.data as AgentNetworkState | undefined;
        let taskContext = "";
        if (state && state.todos.length > 0) {
          taskContext = "\n\n## Current Task Progress:\n";
          state.todos.forEach((t, i) => {
            const marker = i === state.currentTaskIndex ? ">>> " : "";
            const status = t.status;
            taskContext += `${marker}[${status}] ${t.description}\n`;
          });
          taskContext += `\nYou are working on task ${state.currentTaskIndex + 1} of ${state.todos.length}. Focus exclusively on this task until it is complete.\n`;
          if (state.reviewIssues && state.reviewIssues.length > 0) {
            taskContext += `\n## Previous Review Issues (address these):\n${state.reviewIssues.map((issue, i) => `${i + 1}. ${issue}`).join("\n")}\n`;
          }
        }
        // Base prompt (with conversation history) + dynamic task context
        return `${baseSystemPrompt}${taskContext}`;
      },
      model: openai({
        model: "stepfun/step-3.5-flash:free",
        apiKey: process.env.OPENROUTER_API_KEY,
        baseUrl: "https://openrouter.ai/api/v1/",
        defaultParameters: { temperature: 0.3 },
      }),
      tools: [
        createListFilesTool({ internalKey, projectId }),
        createRunCommandTool({ projectId }),
        createWaitForCommandTool({ projectId }),
        createReadFilesTool({ internalKey }),
        createUpdateFileTool({ internalKey }),
        createPatchUpdateTool({ internalKey }),
        createCreateFilesTool({ projectId, internalKey }),
        createCreateFolderTool({ projectId, internalKey }),
        createRenameFileTool({ internalKey }),
        createDeleteFilesTool({ internalKey }),
        createScrapeUrlsTool(),
        createSearchCodebaseTool({ projectId }),
        // Note: readTerminalLogs intentionally NOT provided - use waitForCommand instead
      ],
      lifecycle: {
        onFinish: ({ result, network }) => {
          if (network) {
            // If tools were called, the agent will be called again; skip state update for now
            if (agentMadeToolCalls(result)) {
              return result;
            }

            const fullText = extractText(result.output);

            // Extract JSON block (after the user summary)
            const jsonMatch = fullText.match(/```json\s*([\s\S]*?)\s*```/);
            if (!jsonMatch) {
              throw new Error(
                "Coder did not include a JSON code block in its response",
              );
            }

            let parsed: any;
            try {
              parsed = JSON.parse(jsonMatch[1]);
            } catch (e) {
              throw new Error(`Coder produced invalid JSON: ${jsonMatch[1]}`);
            }

            if (Array.isArray(parsed.todos)) {
              network.state.data.todos = parsed.todos;
            } else {
              throw new Error("Coder JSON missing 'todos' array");
            }
            if (typeof parsed.currentTaskIndex === "number") {
              network.state.data.currentTaskIndex = parsed.currentTaskIndex;
            } else {
              throw new Error("Coder JSON missing 'currentTaskIndex' number");
            }
          }
          return result;
        },
      },
    });

    const reviewerAgent = createAgent({
      name: "reviewer",
      system: REVIEWER_SYSTEM_PROMPT,
      model: openai({
        model: "stepfun/step-3.5-flash:free",
        apiKey: process.env.OPENROUTER_API_KEY,
        baseUrl: "https://openrouter.ai/api/v1/",
        defaultParameters: { temperature: 0.3 },
      }),
      tools: [
        createListFilesTool({ internalKey, projectId }),
        createReadFilesTool({ internalKey }),
        createRunCommandTool({ projectId }),
        createWaitForCommandTool({ projectId }),
        createReadTerminalLogsTool({ projectId }),
        createSearchCodebaseTool({ projectId }),
      ],
      lifecycle: {
        onFinish: ({ result, network }) => {
          if (network) {
            // If tools were called, the agent will be called again; skip state update for now
            if (agentMadeToolCalls(result)) {
              return result;
            }

            const text = extractText(result.output);
            let parsed: any;
            let jsonText = text;
            const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
              jsonText = jsonMatch[1];
            } else {
              // Fallback: try to find a JSON object in the text
              const start = text.indexOf("{");
              const end = text.lastIndexOf("}") + 1;
              if (start !== -1 && end !== -1 && start < end) {
                jsonText = text.substring(start, end);
              }
            }

            try {
              parsed = JSON.parse(jsonText);
            } catch (e) {
              throw new Error(`Reviewer produced invalid JSON: ${text}`);
            }

            network.state.data.reviewIssues = parsed.reviewIssues || [];
            network.state.data.lastReviewSummary =
              parsed.lastReviewSummary || "";

            // Include lint, test, security outputs if provided
            if (parsed.lintErrors?.length) {
              network.state.data.reviewIssues.push(...parsed.lintErrors);
            }
            if (parsed.failedTests?.length) {
              network.state.data.reviewIssues.push(...parsed.failedTests);
            }
            if (parsed.vulnerabilities?.length) {
              network.state.data.reviewIssues.push(...parsed.vulnerabilities);
            }

            network.state.data.reviewed = true;
          }
          return result;
        },
      },
    });

    const debuggerAgent = createAgent({
      name: "debugger",
      system: DEBUGGER_SYSTEM_PROMPT,
      model: openai({
        model: "stepfun/step-3.5-flash:free",
        apiKey: process.env.OPENROUTER_API_KEY,
        baseUrl: "https://openrouter.ai/api/v1/",
        defaultParameters: { temperature: 0.3 },
      }),
      tools: [
        createListFilesTool({ internalKey, projectId }),
        createReadFilesTool({ internalKey }),
        createRunCommandTool({ projectId }),
        createWaitForCommandTool({ projectId }),
        createReadTerminalLogsTool({ projectId }),
        createSearchCodebaseTool({ projectId }),
        // lintProject and runTests removed - use runCommand directly with waitForCommand
      ],
      lifecycle: {
        onFinish: ({ result, network }) => {
          if (network) {
            // If tools were called, the agent will be called again; skip state update for now
            if (agentMadeToolCalls(result)) {
              return result;
            }

            const text = extractText(result.output);
            let parsed: Record<string, string> | null;
            let jsonText = text;
            const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
              jsonText = jsonMatch[1];
            } else {
              // Fallback: try to find a JSON object in the text
              const start = text.indexOf("{");
              const end = text.lastIndexOf("}") + 1;
              if (start !== -1 && end !== -1 && start < end) {
                jsonText = text.substring(start, end);
              }
            }

            try {
              parsed = JSON.parse(jsonText);
            } catch (e) {
              throw new Error(`Debugger produced invalid JSON: ${text}`);
            }

            network.state.data.runtimeHealthy = parsed?.runtimeHealthy ?? false;
            network.state.data.lastDebugSummary =
              parsed?.lastDebugSummary || "";
            if (parsed?.terminalOutput) {
              network.state.data.terminalOutput =
                (network.state.data.terminalOutput || "") +
                parsed?.terminalOutput;
            }
          }
          return result;
        },
      },
    });

    const INITIAL_STATE = createState<AgentNetworkState>({
      todos: [],
      currentTaskIndex: -1,
      reviewIssues: [],
      lastReviewSummary: "",
      reviewed: false,
      terminalOutput: "",
      runtimeHealthy: false,
      lastDebugSummary: "",
      loopCount: 0,
      maxLoopsReached: false,
      pendingCommandId: null,
      commandStartTime: null,
      commandCompleted: false,
      lastCommandOutput: "",
    });

    // Map agent names to their instances for easy lookup
    const agentMap: Record<string, any> = {
      planner: plannerAgent,
      coder: codingAgent,
      reviewer: reviewerAgent,
      debugger: debuggerAgent,
    };

    const network = createNetwork({
      name: "polaris-network",
      agents: [plannerAgent, codingAgent, reviewerAgent, debuggerAgent],
      maxIter: 60,
      defaultState: INITIAL_STATE,
      router: async ({ lastResult, network }) => {
        const state = network.state.data as AgentNetworkState;

        let nextAgentName: string | null = null;
        let nextAgent: any = null;

        if (!lastResult) {
          // First call: start with planner
          nextAgentName = "planner";
          nextAgent = plannerAgent;
        } else {
          const lastAgentName = lastResult.agentName;
          const madeToolCalls = agentMadeToolCalls(lastResult);

          if (madeToolCalls) {
            // Check if agent is in a command polling loop (bad pattern)
            // If the agent just called readTerminalLogs without having completed a command,
            // or if there's a pending command but the agent keeps making tool calls,
            // add a cooldown to prevent token spam
            const lastToolCalls = lastResult.toolCalls || [];
            const calledReadTerminalLogs = lastToolCalls.some((tc) => {
              const name = tc?.tool.name;
              return name === "readTerminalLogs";
            });
            // If agent is polling with readTerminalLogs and there's a pending command,
            // force a cooldown to prevent rapid re-invocation
            if (
              calledReadTerminalLogs &&
              state.pendingCommandId &&
              !state.commandCompleted
            ) {
              // Add a 5-second cooldown before next agent turn
              await step.sleep("router-cooldown", "5s");
            }

            // Repeat the same agent to process tool results
            nextAgentName = lastAgentName;
            nextAgent = agentMap[lastAgentName];
          } else {
            // Normal progression based on last agent
            if (lastAgentName === "planner") {
              if (state.todos.length === 0) {
                // Planner failed to produce tasks, terminate
                nextAgentName = null;
                nextAgent = undefined;
              } else {
                state.currentTaskIndex = 0;
                nextAgentName = "coder";
                nextAgent = codingAgent;
              }
            } else if (lastAgentName === "coder") {
              nextAgentName = "reviewer";
              nextAgent = reviewerAgent;
            } else if (lastAgentName === "reviewer") {
              state.reviewed = true;
              if (state.reviewIssues.length > 0) {
                // Issues found: rework the same task (decrement index to go back)
                if (state.currentTaskIndex > 0) {
                  state.currentTaskIndex--;
                  const task = state.todos[state.currentTaskIndex];
                  if (task) task.status = "in-progress";
                }
                nextAgentName = "coder";
                nextAgent = codingAgent;
              } else {
                // No issues
                const expectsRuntime = state.todos.some((t) =>
                  /run|start|dev|serve|preview|npm run|server/i.test(
                    t.description,
                  ),
                );
                if (expectsRuntime) {
                  nextAgentName = "debugger";
                  nextAgent = debuggerAgent;
                } else {
                  // No runtime needed: check if more tasks remain
                  if (state.currentTaskIndex < state.todos.length -1) {
                    nextAgentName = "coder";
                    nextAgent = codingAgent;
                  } else {
                    // All tasks completed
                    nextAgentName = null;
                    nextAgent = undefined;
                  }
                }
              }
            } else if (lastAgentName === "debugger") {
              if (state.runtimeHealthy) {
                // Debug passed: check if more tasks remain
                if (state.currentTaskIndex < state.todos.length -1) {
                  nextAgentName = "coder";
                  nextAgent = codingAgent;
                } else {
                  nextAgentName = null;
                  nextAgent = undefined;
                }
              } else {
                // Runtime issues: rework the same task (decrement index)
                if (state.currentTaskIndex > 0) {
                  state.currentTaskIndex--;
                  const task = state.todos[state.currentTaskIndex];
                  if (task) task.status = "in-progress";
                }
                nextAgentName = "coder";
                nextAgent = codingAgent;
              }
            } else {
              nextAgentName = null;
              nextAgent = undefined;
            }
          }
        }

        // Increment loop count only when moving to a different agent (or initial start)
        if (
          nextAgent &&
          (!lastResult || nextAgentName !== lastResult.agentName)
        ) {
          state.loopCount = (state.loopCount || 0) + 1;
          if (state.loopCount > 40) {
            state.maxLoopsReached = true;
            return undefined;
          }
        }

        return nextAgent;
      },
    });

    // Run the full network
    const result = await network.run(message);

    // Extract clean summary from the LAST coder response only
    const results = result.state.results ?? [];
    const lastCoder = [...results]
      .reverse()
      .find((r: any) => r.agentName === "coder");

    let assistantResponse =
      "I processed your request. Let me know if you need anything else!";
    if (lastCoder) {
      let text = extractText(lastCoder.output);
      // Remove the JSON block so user never sees it
      const jsonIndex = text.indexOf("```json");
      if (jsonIndex !== -1) text = text.slice(0, jsonIndex).trim();
      if (text) assistantResponse = text;
    }

    // Save final response
    await step.run("update-assistant-message", async () =>
      convex.mutation(api.system.updateMessageContent, {
        internalKey,
        messageId,
        content: assistantResponse,
      }),
    );

    return { success: true, messageId, conversationId };
  },
);
