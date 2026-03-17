/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WebContainer } from "@webcontainer/api";

import { buildFileTree, getFilePath } from "@/features/preview/utils/file-tree";
import { useFiles } from "@/features/projects/hooks/use-files";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { BoundedSet } from "@/lib/utils";

let webcontainerInstance: WebContainer | null = null;
let bootPromise: Promise<WebContainer> | null = null;

const getWebContainer = async (): Promise<WebContainer> => {
  if (webcontainerInstance) return webcontainerInstance;

  if (!bootPromise) {
    bootPromise = WebContainer.boot({ coep: "credentialless" }).then((wc) => {
      webcontainerInstance = wc;
      return wc;
    });
  }

  return bootPromise;
};

const teardownWebContainer = () => {
  if (webcontainerInstance) {
    webcontainerInstance.teardown();
    webcontainerInstance = null;
  }
  bootPromise = null;
};

// Helper: generate hash of dependency files
const hashDependencies = (files: Doc<"files">[]) => {
  const depFiles = files.filter(
    (f) => f.name === "package.json" || f.name === "package-lock.json",
  );
  return depFiles.map((f) => f.content || "").join("|");
};

interface UseWebContainerProps {
  projectId: Id<"projects">;
  enabled: boolean;
  settings?: {
    installCommand?: string;
    devCommand?: string;
  };
}

export const useWebContainer = ({
  projectId,
  enabled,
  settings,
}: UseWebContainerProps) => {
  const [status, setStatus] = useState<
    "idle" | "booting" | "installing" | "running" | "error"
  >("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  const [terminalOutput, setTerminalOutput] = useState("");

  const containerRef = useRef<WebContainer | null>(null);
  const hasStartedRef = useRef(false);
  const lastDepHashRef = useRef<string | null>(null);

  const commands = useQuery(api.commands.getPending, { projectId });
  const processedRef = useRef(new BoundedSet<string>(100));
  const updateCommand = useMutation(api.commands.update);
  const files = useFiles(projectId);

  const sendCallback = async (payload: any, maxRetries = 3) => {
    let attempt = 0;
    let delay = 500; // start with 500ms

    while (attempt < maxRetries) {
      try {
        const res = await fetch("/api/inngest/callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return; // success
      } catch (err) {
        attempt++;
        console.warn(
          `Callback attempt ${attempt} failed for command ${payload.commandId}:`,
          err,
        );
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, delay));
          delay *= 2; // exponential backoff
        } else {
          console.error(
            `All callback attempts failed for command ${payload.commandId}`,
          );
        }
      }
    }
  };

  const runCommand = useCallback(
    async (cmd: any) => {
      const container = containerRef.current;
      if (!container) return;

      let outputBuffer = "";

      const appendOutput = (data: string) => {
        outputBuffer += data;
        setTerminalOutput((prev) => prev + data);
      };

      try {
        await updateCommand({
          id: cmd._id,
          status: "running",
        });

        const [bin, ...args] = cmd.command.split(" ");

        appendOutput(`\n$ ${cmd.command}\n`);

        const process = await container.spawn(bin, args);

        process.output.pipeTo(
          new WritableStream<string>({
            write(chunk) {
              appendOutput(chunk);
            },
          }),
        );
        const exitCode = await process.exit;

        await updateCommand({
          id: cmd._id,
          status: exitCode === 0 ? "completed" : "failed",
          output: outputBuffer,
        });

        // Notify Inngest that command has completed (event-driven unblock)
        await sendCallback({
          commandId: cmd._id,
          projectId: projectId,
          status: exitCode === 0 ? "completed" : "failed",
          output: outputBuffer,
          exitCode,
        });
      } catch (err) {
        await updateCommand({
          id: cmd._id,
          status: "failed",
          output: String(err),
        });

        // Notify Inngest that command has failed (event-driven unblock)
        try {
          await fetch("/api/inngest/callback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commandId: cmd._id,
              status: "failed",
              output: String(err),
            }),
          });
        } catch (callbackErr) {
          console.error(
            "Failed to send command completion callback:",
            callbackErr,
          );
        }
      }
    },
    [updateCommand, projectId],
  );

  // Initial boot and mount
  useEffect(() => {
    if (!enabled) return;
    if (containerRef.current) return;

    hasStartedRef.current = true;

    const start = async () => {
      if (files) {
        try {
          setStatus("booting");
          setError(null);
          setTerminalOutput("");

          const appendOutput = (data: string) => {
            setTerminalOutput((prev) => prev + data);
          };

          const container = await getWebContainer();
          containerRef.current = container;

          // Mount files (full tree)
          const fileTree = buildFileTree(files);
          await container.mount(fileTree);

          container.on("server-ready", (_port, url) => {
            setPreviewUrl(url);
            setStatus("running");
          });

          setStatus("installing");

          // Dependency caching
          const depHash = hashDependencies(files);
          if (depHash !== lastDepHashRef.current) {
            lastDepHashRef.current = depHash;

            const installCmd = settings?.installCommand || "npm install";
            const [installBin, ...installArgs] = installCmd.split(" ");
            appendOutput(`$ ${installCmd}\n`);
            const installProcess = await container.spawn(
              installBin,
              installArgs,
            );
            installProcess.output.pipeTo(
              new WritableStream({ write: (data) => appendOutput(data) }),
            );
            const installExitCode = await installProcess.exit;
            if (installExitCode !== 0)
              throw new Error(
                `${installCmd} failed with code ${installExitCode}`,
              );
          } else {
            appendOutput("$ dependencies cached, skipping install\n");
          }

          // Start dev server
          const devCmd = settings?.devCommand || "npm run dev";
          const [devBin, ...devArgs] = devCmd.split(" ");
          appendOutput(`\n$ ${devCmd}\n`);
          const devProcess = await container.spawn(devBin, devArgs);
          devProcess.output.pipeTo(
            new WritableStream({ write: (data) => appendOutput(data) }),
          );
        } catch (err) {
          setError(err instanceof Error ? err.message : "Unknown error");
          setStatus("error");
        }
      }
    };

    start();
  }, [
    enabled,
    files,
    restartKey,
    settings?.devCommand,
    settings?.installCommand,
  ]);

  // Hot-reload file changes with diff detection
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !files || status !== "running") return;

    const updateFiles = async () => {
      const filesMap = new Map(files.map((f) => [f._id, f]));
      for (const file of files) {
        if (file.type !== "file" || file.storageId || !file.content) continue;
        const filePath = getFilePath(file, filesMap);

        let existingContent: string | null = null;
        try {
          existingContent = await container.fs.readFile(filePath, "utf-8");
        } catch {
          // file does not exist yet
        }

        if (existingContent !== file.content) {
          await container.fs.writeFile(filePath, file.content);
        }
      }
    };

    updateFiles();
  }, [files, status]);

  // Reset when disabled
  useEffect(() => {
    if (!enabled) {
      hasStartedRef.current = false;
      setStatus("idle");
      setPreviewUrl(null);
      setError(null);
    }
  }, [enabled]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !commands) return;

    const run = async () => {
      for (const cmd of commands) {
        if (processedRef.current.has(cmd._id)) continue;

        processedRef.current.add(cmd._id);
        await runCommand(cmd);
      }
    };

    run();
  }, [commands, runCommand]);

  // Restart container
  const restart = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.teardown();
    }

    containerRef.current = null;
    webcontainerInstance = null;
    bootPromise = null;
    hasStartedRef.current = false;

    setStatus("idle");
    setPreviewUrl(null);
    setError(null);
    setRestartKey((k) => k + 1);
  }, []);

  return {
    status,
    previewUrl,
    error,
    restart,
    terminalOutput,
  };
};
