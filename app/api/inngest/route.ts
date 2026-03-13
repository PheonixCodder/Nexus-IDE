import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { importGithubRepo } from "@/features/projects/inngest/import-github-repo";
import { exportToGithub } from "@/features/projects/inngest/export-to-github";
import { processMessage } from "@/features/conversations/inngest/process-message";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processMessage, importGithubRepo, exportToGithub],
});
