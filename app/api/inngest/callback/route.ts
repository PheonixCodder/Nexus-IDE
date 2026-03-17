import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

interface CallbackRequestBody {
  commandId: string;
  projectId: Id<"projects">;
  status: "completed" | "failed";
  output: string;
  exitCode?: number;
}

export async function POST(request: NextRequest) {
  try {
    const body: CallbackRequestBody = await request.json();

    // Validate required fields
    if (!body.commandId || !body.status || body.output === undefined) {
      return NextResponse.json(
        { error: "Missing required fields: commandId, status, output" },
        { status: 400 },
      );
    }

    await convex.mutation(api.commandEvents.create, {
      commandId: body.commandId,
      projectId: body.projectId,
      status: body.status,
      output: body.output,
      exitCode: body.exitCode,
      createdAt: Date.now(),
    });

    // Send event to Inngest to unblock any waiting agents
    await inngest.send({
      name: "terminal/command.completed",
      data: body,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error processing callback:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
