import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { importGithubRepo } from "@/features/projects/inngest/import-github-repo";
import { exportToGithub } from "@/features/projects/inngest/export-to-github";
import { processMessage } from "@/features/conversations/inngest/process-message";
import { indexFile, deleteFileIndex } from "@/features/conversations/inngest/create-indexs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processMessage, importGithubRepo, exportToGithub, indexFile, deleteFileIndex],
});
