import { QdrantClient } from "@qdrant/js-client-rest";

export function getQdrantClient() {
  return new QdrantClient({
    url: "http://127.0.0.1:6333",
  });
}
