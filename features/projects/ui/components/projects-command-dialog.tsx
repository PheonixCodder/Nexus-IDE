"use client";

import { useRouter } from "next/navigation";
import { Github, GlobeIcon, Loader2Icon, AlertCircleIcon } from "lucide-react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Doc } from "@/convex/_generated/dataModel";
import { useProjects } from "../../hooks/use-projects";

interface ProjectsCommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const getProjectIcon = (project: Doc<"projects">) => {
  if (project.importStatus === "completed") {
    return <Github className="size-4 text-muted-foreground" data-icon />;
  }

  if (project.importStatus === "failed") {
    return (
      <AlertCircleIcon className="size-4 text-muted-foreground" data-icon />
    );
  }

  if (project.importStatus === "importing") {
    return (
      <Loader2Icon
        className="size-4 text-muted-foreground animate-spin"
        data-icon
      />
    );
  }

  return <GlobeIcon className="size-4 text-muted-foreground" data-icon />;
};

export const ProjectsCommandDialog = ({
  open,
  onOpenChange,
}: ProjectsCommandDialogProps) => {
  const router = useRouter();
  const projects = useProjects();

  const handleSelect = (projectId: string) => {
    router.push(`/projects/${projectId}`);
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search Projects"
      description="Search and navigate to your projects"
    >
      <Command>
        <CommandInput placeholder="Search projects..." />
        <CommandList>
          <CommandEmpty>No projects found.</CommandEmpty>
          <CommandGroup heading="Projects">
            {projects?.map((project) => (
              <CommandItem
                key={project._id}
                value={`${project.name}-${project._id}`}
                onSelect={() => handleSelect(project._id)}
              >
                {getProjectIcon(project)}
                <span>{project.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
};
