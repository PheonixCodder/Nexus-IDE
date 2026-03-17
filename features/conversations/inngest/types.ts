export interface AgentNetworkState {
  // Planner writes this
  todos: Array<{
    id: number;
    description: string;
    status: "pending" | "in-progress" | "done" | "failed";
    result?: string; // optional summary after completion
    error?: string;
  }>;

  currentTaskIndex: number; // 0-based, planner sets to 0, coder increments

  // Reviewer writes these
  reviewIssues: string[]; // list of problems found (empty = good)
  lastReviewSummary: string; // short verdict text
  reviewed: boolean; // true after reviewer has run at least once this cycle

  // Debugger writes / appends
  terminalOutput: string; // accumulated relevant logs (not full firehose)
  runtimeHealthy: boolean; // true = app appears to run without fatal errors
  lastDebugSummary: string;

  // Command execution state (prevents polling loops)
  pendingCommandId: string | null;  // ID of currently executing command
  commandStartTime: number | null;  // When command started (for timeout estimation)
  commandCompleted: boolean;        // Set to true when waitForCommand finishes
  lastCommandOutput: string;        // Cached tail of last command output

  // Optional safety / observability
  loopCount: number;
  maxLoopsReached: boolean;
}
