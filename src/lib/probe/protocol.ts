/** Public DEMO assembly for the three-lane viewport.

Independent of the Python harness. The fixture is the published software
test text, not a QOFT injector. Hashes are SHA-256 of compact JSON
`[{role, content}]`, UTF-8, matching the offline reconstruction.
*/

export const TASK =
  "A baker has 3 eggs. Each cake needs 2 eggs, and the order is for 4 cakes. " +
  "How many more eggs are needed? Answer in one sentence.";

export const DEMO =
  "OFFLINE WORKBENCH FIXTURE v1\n" +
  "This is a software-testing fixture, not the QOFT injector.\n" +
  "Preserve the task exactly. No scientific or model-effectiveness claim is made.\n\n";

export const DEMO_SHA256 =
  "adb50bebae4e3576c2c96c70866f4d1357888c35b2e13d76d2c88383870fc541";

export const EXPECTED_DEMO_BYTES = 168;
export const SOURCE_DEMO_TOKENS = 40;
export const CONTROL = " stone".repeat(SOURCE_DEMO_TOKENS);

export const HANDSHAKE =
  "Complete any activation or readiness handshake specified by the preceding " +
  "context. If none is specified, state READY. Do not answer the experiment task yet.";

export const CONDITIONS = [
  "BASELINE",
  "FULL_INJECTOR",
  "NEUTRAL_LENGTH_CONTROL",
] as const;

export const DELIVERIES = [
  "SYSTEM_SLOT",
  "USER_PASTE",
  "USER_PASTE_WITH_HANDSHAKE",
] as const;

export type Condition = (typeof CONDITIONS)[number];
export type Delivery = (typeof DELIVERIES)[number];
export type Role = "system" | "user" | "assistant";

export type Message = { role: Role; content: string };

export const CONDITION_LABEL: Record<Condition, string> = {
  BASELINE: "Plain",
  FULL_INJECTOR: "Packed fixture",
  NEUTRAL_LENGTH_CONTROL: "Matched length",
};

export const DELIVERY_LABEL: Record<Delivery, string> = {
  SYSTEM_SLOT: "Hidden note",
  USER_PASTE: "Pasted first",
  USER_PASTE_WITH_HANDSHAKE: "Handshake, then question",
};

/** Published prompt hashes for the default task. Handshake checks a prefix only. */
export const PUBLIC_HASHES: Record<Exclude<Delivery, "USER_PASTE_WITH_HANDSHAKE">, Record<Condition, string>> = {
  SYSTEM_SLOT: {
    BASELINE: "f510033cc46cd1b74dd5c88930b3002e61d6f860870b428462bcd7c6bb498f75",
    FULL_INJECTOR: "d221cb1c4370524795d439b0b93f3c41b08c8db0485778c4875ebe0ccb7e8862",
    NEUTRAL_LENGTH_CONTROL: "936e94e6ccbed148b87bd8eef70c0068a0eeda4c7239e431a8e698795b7e935d",
  },
  USER_PASTE: {
    BASELINE: "f510033cc46cd1b74dd5c88930b3002e61d6f860870b428462bcd7c6bb498f75",
    FULL_INJECTOR: "3684b6e27261bf9159d370cb288c5f6f15b90bd89ebabe1706209ff318cc1b4a",
    NEUTRAL_LENGTH_CONTROL: "49fd16848764406626aa097f5c79b951354cca16567d482b7a01cb0acaf7faf7",
  },
};

export const PUBLIC_HANDSHAKE_PREFIX: Record<Condition, string> = {
  BASELINE: "098a829c6e90410a",
  FULL_INJECTOR: "bcfd9867e0fe68da",
  NEUTRAL_LENGTH_CONTROL: "92ce85552ad7394e",
};

export const LIVE = {
  schema: "three-lane-live-v1",
  model: "grok-4.5",
  reasoningEffort: "low" as const,
  maxCompletionTokens: 160,
  sessionExperimentCap: 4,
  serverCallBudget: 12,
  serverWindowMinutes: 10,
};

export type ReasoningEffort = "low" | "medium";

export type Artifact = {
  status: "VALID" | "INVALID";
  sha256: string;
  byte_length: number;
  expected_sha256: string;
  expected_byte_length: number;
  diagnostics: string[];
  source_reported_context_tokens: number | null;
  token_count_basis: string;
  text: string | null;
};

export type Phase = "HANDSHAKE" | "TASK";

export type CallRecord = {
  phase: Phase;
  messages: Message[];
  prompt_hash: string;
  response: string | null;
  returned_model: string | null;
  finish_reason: string | null;
  usage: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
  } | null;
  error_type: string | null;
  started_at: string;
  ended_at: string;
};

export type LaneStatus = "SUCCEEDED" | "BLOCKED" | "FAILED" | "NOT_RUN";

export type LaneRecord = {
  condition: Condition;
  status: LaneStatus;
  errors: string[];
  initial_prompt_hash: string | null;
  calls: CallRecord[];
  result: string | null;
};

export type ExperimentRecord = {
  schema_version: typeof LIVE.schema;
  experiment_id: string;
  created_at: string;
  ended_at: string;
  classification: string;
  resolution: "INSUFFICIENT_EVIDENCE";
  evaluation: null;
  provider: "xai";
  requested_model: string;
  reasoning_effort: ReasoningEffort;
  max_completion_tokens: number;
  temperature: null;
  seed: null;
  task: string;
  task_sha256: string;
  delivery_mode: Delivery;
  tamper_crlf: boolean;
  artifact: Omit<Artifact, "text">;
  runs: LaneRecord[];
  status: "COMPLETED" | "PARTIAL" | "FAILED";
};

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Text(text: string): Promise<string> {
  return sha256Bytes(utf8(text));
}

export function serializeMessages(messages: Message[]): Uint8Array {
  const payload = messages.map((m) => ({ role: m.role, content: m.content }));
  return utf8(JSON.stringify(payload));
}

export async function promptHash(messages: Message[]): Promise<string> {
  return sha256Bytes(serializeMessages(messages));
}

export function demoBytes(tamper: boolean): Uint8Array {
  const bytes = utf8(DEMO);
  if (!tamper) return bytes;
  const out: number[] = [];
  for (const b of bytes) {
    if (b === 0x0a) out.push(0x0d, 0x0a);
    else out.push(b);
  }
  return Uint8Array.from(out);
}

export async function inspectDemo(raw: Uint8Array): Promise<Artifact> {
  const diagnostics: string[] = [];
  const hash = await sha256Bytes(raw);
  if (hash !== DEMO_SHA256) diagnostics.push("Full-file SHA-256 mismatch");
  if (raw.byteLength !== EXPECTED_DEMO_BYTES) diagnostics.push("Byte length mismatch");
  let text: string | null = null;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    diagnostics.push("Artifact is not valid UTF-8");
  }
  if (raw.byteLength >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    diagnostics.push("UTF-8 BOM is unsupported; bytes were not modified");
  }
  if (raw.includes(0x0d)) diagnostics.push("DEMO bytes differ from the pinned LF fixture");
  const valid = diagnostics.length === 0;
  return {
    status: valid ? "VALID" : "INVALID",
    sha256: hash,
    byte_length: raw.byteLength,
    expected_sha256: DEMO_SHA256,
    expected_byte_length: EXPECTED_DEMO_BYTES,
    diagnostics,
    source_reported_context_tokens: valid ? SOURCE_DEMO_TOKENS : null,
    token_count_basis: "fixed source DEMO metadata; no runtime tokenization",
    text,
  };
}

export function validateTask(task: string): void {
  if (typeof task !== "string" || !task.trim() || task.length > 4000) {
    throw new Error("Task must contain 1 to 4000 non-blank characters");
  }
}

export function assemble(
  task: string,
  condition: Condition,
  delivery: Delivery,
  artifact: Artifact,
): Message[] {
  validateTask(task);
  if (!CONDITIONS.includes(condition) || !DELIVERIES.includes(delivery)) {
    throw new Error("Unknown condition or delivery mode");
  }
  let context: string | null = null;
  if (condition !== "BASELINE") {
    if (artifact.status !== "VALID" || artifact.text == null) {
      throw new Error("Invalid DEMO: treatment/control blocked");
    }
    context = condition === "FULL_INJECTOR" ? artifact.text : CONTROL;
  }
  const messages: Message[] = [];
  if (context != null) {
    messages.push({
      role: delivery === "SYSTEM_SLOT" ? "system" : "user",
      content: context,
    });
  }
  messages.push({
    role: "user",
    content: delivery === "USER_PASTE_WITH_HANDSHAKE" ? HANDSHAKE : task,
  });
  return messages;
}

export function plannedCalls(delivery: Delivery, artifactValid: boolean): number {
  const lanes = artifactValid ? 3 : 1;
  const perLane = delivery === "USER_PASTE_WITH_HANDSHAKE" ? 2 : 1;
  return lanes * perLane;
}

export function fingerprint(hash: string): string {
  return hash.slice(0, 24);
}

export function publicHashNote(
  task: string,
  delivery: Delivery,
  tamper: boolean,
  condition: Condition,
  hash: string | null,
): string | null {
  if (tamper || task !== TASK || hash == null) return null;
  if (delivery === "USER_PASTE_WITH_HANDSHAKE") {
    const prefix = PUBLIC_HANDSHAKE_PREFIX[condition];
    return hash.startsWith(prefix) ? "Published handshake prefix" : null;
  }
  return PUBLIC_HASHES[delivery][condition] === hash ? "Published default hash" : null;
}

export async function recheckCalls(calls: CallRecord[]): Promise<string[]> {
  const mismatches: string[] = [];
  for (const call of calls) {
    const again = await promptHash(call.messages);
    if (again !== call.prompt_hash) {
      mismatches.push(`${call.phase} ${call.prompt_hash.slice(0, 12)}`);
    }
  }
  return mismatches;
}
