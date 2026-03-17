import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { convex } from "@/lib/convex-client";
import { createTool } from "@inngest/agent-kit";

export const createSecurityAuditTool = ({
  projectId,
}: {
  projectId: Id<"projects">;
}) =>
  createTool({
    name: "securityAudit",
    description: "Run npm audit to detect vulnerabilities",
    handler: async (_params, { step }) => {
      const result = await step?.run("run-audit", async () => {
        await convex.mutation(api.commands.enqueue, {
          projectId,
          command: "npm audit --json",
        });
        return "Security audit queued";
      });
      return result;
    },
  });
