import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { convex } from "@/lib/convex-client";
import { createTool } from "@inngest/agent-kit";

export const createLintTool = ({ projectId }: { projectId: Id<"projects"> }) =>
  createTool({
    name: "lintProject",
    description: "Run ESLint/TS checks on the project",
    handler: async (_params, { step }) => {
      const result = await step?.run("run-lint", async () => {
        // enqueue lint command
        await convex.mutation(api.commands.enqueue, {
          projectId,
          command: "npx eslint . --max-warnings=0",
        });
        return "Lint command queued";
      });
      return result;
    },
  });
