import { BedrockRuntimeClient, ConverseCommand, type ImageFormat } from "@aws-sdk/client-bedrock-runtime";

export interface BolReading {
  inTime: string | null;
  outTime: string | null;
  receiverSigned: boolean;
  legible: boolean;
  notes: string;
}

const RECORD_TOOL = "record_bol_reading";

// The model is asked for what is written, through a forced tool call, so its answer arrives as
// typed fields rather than prose. Whether those fields are believed is decided elsewhere.
const recordTool = {
  toolSpec: {
    name: RECORD_TOOL,
    description: "Record exactly what is written on a photographed bill of lading.",
    inputSchema: {
      json: {
        type: "object",
        required: ["in_time", "out_time", "receiver_signed", "legible", "notes"],
        properties: {
          in_time: { type: ["string", "null"], description: "Check-in or arrival time written on the document, as written; null if not visible" },
          out_time: { type: ["string", "null"], description: "Check-out or release time written on the document, as written; null if not visible" },
          receiver_signed: { type: "boolean", description: "True only if a handwritten receiver signature is visible" },
          legible: { type: "boolean", description: "False if the photo is too blurry, dark or cropped to read" },
          notes: { type: "string", description: "One sentence on what is and is not readable" },
        },
      },
    },
  },
};

function formatOf(mimeType: string): ImageFormat {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  return "jpeg";
}

export async function readBol(
  image: Uint8Array,
  mimeType: string,
  modelId: string,
  client: BedrockRuntimeClient = new BedrockRuntimeClient({}),
): Promise<BolReading> {
  const out = await client.send(
    new ConverseCommand({
      modelId,
      messages: [
        {
          role: "user",
          content: [
            { image: { format: formatOf(mimeType), source: { bytes: image } } },
            { text: "This is a truck driver's photo of a bill of lading. Read only what is written. Never guess a time that is not visible." },
          ],
        },
      ],
      toolConfig: { tools: [recordTool], toolChoice: { tool: { name: RECORD_TOOL } } },
      inferenceConfig: { maxTokens: 400, temperature: 0 },
    }),
  );
  const use = out.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
  const input = (use?.input ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    inTime: text(input.in_time),
    outTime: text(input.out_time),
    receiverSigned: input.receiver_signed === true,
    legible: input.legible === true,
    notes: text(input.notes) ?? "",
  };
}
