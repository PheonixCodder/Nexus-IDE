import { openrouter } from "@/lib/openrouter";
import { embed } from "ai";

export const embedChunk = async (chunk: string) => {
  const { embedding } = await embed({
    model: openrouter.textEmbeddingModel(
      "nvidia/llama-nemotron-embed-vl-1b-v2:free",
    ),
    value: chunk,
  });

  return embedding;
};
