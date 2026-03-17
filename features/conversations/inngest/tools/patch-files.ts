import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";
import { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";

interface PatchUpdateToolOptions {
  internalKey: string;
}

const patchSchema = z.object({
  type: z.enum([
    "replace",
    "regexReplace",
    "insertAfter",
    "insertBefore",
    "replaceBlock",
    "appendToFile",
    "prependToFile",
    "delete",
  ]),
  find: z.string().optional(),
  replace: z.string().optional(),
  content: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  regex: z.string().optional(),
});

const paramsSchema = z.object({
  fileId: z.string(),
  patches: z.array(patchSchema).min(1),
});

function applyPatch(content: string, patch: z.infer<typeof patchSchema>) {
  switch (patch.type) {
    case "replace":
      if (!patch.find || !patch.replace)
        throw new Error("replace requires find and replace");
      return content.replace(patch.find, patch.replace);

    case "regexReplace":
      if (!patch.regex || !patch.replace)
        throw new Error("regexReplace requires regex and replace");
      return content.replace(new RegExp(patch.regex, "g"), patch.replace);

    case "insertAfter": {
      if (!patch.find) throw new Error("insertAfter requires find");
      const idx = content.indexOf(patch.find);
      if (idx === -1) throw new Error(`Pattern not found: ${patch.find}`);

      const pos = idx + patch.find.length;

      return (
        content.slice(0, pos) +
        "\n" +
        (patch.content ?? "") +
        "\n" +
        content.slice(pos)
      );
    }

    case "insertBefore": {
      if (!patch.find) throw new Error("insertBefore requires find");
      const idx = content.indexOf(patch.find);
      if (idx === -1) throw new Error(`Pattern not found: ${patch.find}`);

      return (
        content.slice(0, idx) +
        (patch.content ?? "") +
        "\n" +
        content.slice(idx)
      );
    }

    case "replaceBlock": {
      if (!patch.start || !patch.end)
        throw new Error("replaceBlock requires start and end markers");

      const startIdx = content.indexOf(patch.start);
      const endIdx = content.indexOf(patch.end);

      if (startIdx === -1 || endIdx === -1)
        throw new Error("Block markers not found");

      return (
        content.slice(0, startIdx + patch.start.length) +
        "\n" +
        (patch.content ?? "") +
        "\n" +
        content.slice(endIdx)
      );
    }

    case "appendToFile":
      return content + "\n" + (patch.content ?? "");

    case "prependToFile":
      return (patch.content ?? "") + "\n" + content;

    case "delete":
      if (!patch.find) throw new Error("delete requires find");
      return content.replace(patch.find, "");

    default:
      throw new Error(`Unsupported patch type: ${patch.type}`);
  }
}

export const createPatchUpdateTool = ({
  internalKey,
}: PatchUpdateToolOptions) => {
  return createTool({
    name: "patchFile",
    description:
      "Apply targeted patches to a file without replacing the entire file content. Supports replace, insertAfter, insertBefore, and delete operations.",

    parameters: z.object({
      fileId: z.string().describe("ID of the file to patch"),
      patches: z.array(
        z.object({
          type: z.enum(["replace", "insertAfter", "insertBefore", "delete"]),
          find: z.string().describe("Text to search for"),
          replace: z.string().optional(),
          content: z.string().optional(),
        }),
      ),
    }),

    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);

      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { fileId, patches } = parsed.data;

      const file = await convex.query(api.system.getFileById, {
        internalKey,
        fileId: fileId as Id<"files">,
      });

      if (!file) {
        return `Error: File "${fileId}" not found`;
      }

      if (file.type === "folder") {
        return `Error: "${fileId}" is a folder`;
      }

      if (!file.content) {
        return `Error: File has no text content`;
      }

      try {
        return await toolStep?.run("patch-update", async () => {
          let newContent = file.content;

          for (const patch of patches) {
            newContent = applyPatch(newContent as string, patch);
          }

          await convex.mutation(api.system.updateFile, {
            internalKey,
            fileId: fileId as Id<"files">,
            content: newContent as string,
          });

          return `Applied ${patches.length} patch(es) to ${file.name}`;
        });
      } catch (error) {
        return `Patch failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`;
      }
    },
  });
};
