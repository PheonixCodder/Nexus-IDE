import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { convex } from "@/lib/convex-client";
import { createTool } from "@inngest/agent-kit";

export const createRunTestsTool = ({
  projectId,
}: {
  projectId: Id<"projects">;
}) =>
  createTool({
    name: "runTests",
    description: "Run project unit/integration tests",
    handler: async (_params, { step }) => {
      const result = await step?.run("run-tests", async () => {
        await convex.mutation(api.commands.enqueue, {
          projectId,
          command: "npm test -- --ci --reporters default",
        });
        return "Test command queued";
      });
      return result;
    },
  });
