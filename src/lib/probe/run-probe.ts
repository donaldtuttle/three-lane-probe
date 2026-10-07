import { createServerFn } from "@tanstack/react-start";
import {
  LIVE,
  type CallRecord,
  type Condition,
  type Delivery,
  type Message,
  type Phase,
  type ReasoningEffort,
  assemble,
  demoBytes,
  inspectDemo,
  promptHash,
  validateTask,
} from "./protocol.ts";

const stamps: number[] = [];

function takeBudget(): boolean {
  const now = Date.now();
  const windowMs = LIVE.serverWindowMinutes * 60 * 1000;
  while (stamps.length > 0 && now - stamps[0]! > windowMs) stamps.shift();
  if (stamps.length + 1 > LIVE.serverCallBudget) return false;
  stamps.push(now);
  return true;
}

type ChatResult =
  | {
      ok: true;
      content: string;
      model: string | null;
      finish_reason: string | null;
      usage: CallRecord["usage"];
    }
  | { ok: false; error_type: string };

async function complete(
  apiKey: string,
  messages: Message[],
  effort: ReasoningEffort,
): Promise<ChatResult> {
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model: LIVE.model,
        messages,
        max_completion_tokens: LIVE.maxCompletionTokens,
        reasoning_effort: effort,
      }),
    });
    if (!res.ok) return { ok: false, error_type: `http_${res.status}` };
    const body = (await res.json()) as {
      model?: unknown;
      choices?: {
        finish_reason?: unknown;
        message?: { content?: unknown };
      }[];
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
      };
    };
    const choice = body.choices?.[0];
    const content = choice?.message?.content;
    const usage = body.usage;
    const num = (value: unknown) => (typeof value === "number" ? value : null);
    return {
      ok: true,
      content: typeof content === "string" ? content : "",
      model: typeof body.model === "string" ? body.model : null,
      finish_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      usage: usage
        ? {
            prompt_tokens: num(usage.prompt_tokens),
            completion_tokens: num(usage.completion_tokens),
            total_tokens: num(usage.total_tokens),
          }
        : null,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return {
      ok: false,
      error_type: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
    };
  }
}

function snapshot(messages: Message[]): Message[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

async function recordCall(
  apiKey: string,
  messages: Message[],
  phase: Phase,
  effort: ReasoningEffort,
): Promise<CallRecord> {
  const frozen = snapshot(messages);
  const started = new Date().toISOString();
  const hash = await promptHash(frozen);
  const result = await complete(apiKey, frozen, effort);
  const ended = new Date().toISOString();
  if (!result.ok) {
    return {
      phase,
      messages: frozen,
      prompt_hash: hash,
      response: null,
      returned_model: null,
      finish_reason: null,
      usage: null,
      error_type: result.error_type,
      started_at: started,
      ended_at: ended,
    };
  }
  return {
    phase,
    messages: frozen,
    prompt_hash: hash,
    response: result.content,
    returned_model: result.model,
    finish_reason: result.finish_reason,
    usage: result.usage,
    error_type: null,
    started_at: started,
    ended_at: ended,
  };
}

export type LaneRequest = {
  task: string;
  delivery: Delivery;
  tamper: boolean;
  consent: boolean;
  reasoningEffort: ReasoningEffort;
  condition: Condition;
  phase: Phase;
  priorAssistant: string | null;
};

function parseLane(input: unknown): LaneRequest {
  if (!input || typeof input !== "object") throw new Error("Missing request");
  const raw = input as Record<string, unknown>;
  const delivery = raw.delivery;
  if (delivery !== "SYSTEM_SLOT" && delivery !== "USER_PASTE" && delivery !== "USER_PASTE_WITH_HANDSHAKE") {
    throw new Error("Unknown delivery mode");
  }
  const condition = raw.condition;
  if (condition !== "BASELINE" && condition !== "FULL_INJECTOR" && condition !== "NEUTRAL_LENGTH_CONTROL") {
    throw new Error("Unknown condition");
  }
  const phase = raw.phase;
  if (phase !== "HANDSHAKE" && phase !== "TASK") throw new Error("Unknown phase");
  if (typeof raw.task !== "string") throw new Error("Task must contain 1 to 4000 non-blank characters");
  validateTask(raw.task);
  if (raw.reasoningEffort != null && raw.reasoningEffort !== "low" && raw.reasoningEffort !== "medium") {
    throw new Error("Reasoning effort must be low or medium");
  }
  const prior = raw.priorAssistant;
  if (prior != null && typeof prior !== "string") throw new Error("Handshake reply is missing.");
  if (typeof prior === "string" && prior.length > 8000) throw new Error("Handshake reply is too long.");
  return {
    task: raw.task,
    delivery,
    tamper: raw.tamper === true,
    consent: raw.consent === true,
    reasoningEffort: raw.reasoningEffort === "medium" ? "medium" : "low",
    condition,
    phase,
    priorAssistant: typeof prior === "string" ? prior : null,
  };
}

export type LaneResult =
  | { ok: false; error: string }
  | { ok: true; blocked: true; diagnostics: string[] }
  | { ok: true; blocked: false; call: CallRecord; initial_prompt_hash: string };

export const runLane = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseLane(input))
  .handler(async ({ data }): Promise<LaneResult> => {
    if (!data.consent) return { ok: false, error: "Consent is required before a live call." };
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false, error: "AI is not available in this environment." };

    const artifact = await inspectDemo(demoBytes(data.tamper));
    if (data.condition !== "BASELINE" && artifact.status !== "VALID") {
      return { ok: true, blocked: true, diagnostics: [...artifact.diagnostics] };
    }
    if (data.phase === "HANDSHAKE" && data.delivery !== "USER_PASTE_WITH_HANDSHAKE") {
      return { ok: false, error: "Handshake is only used for that delivery." };
    }

    let messages = assemble(data.task, data.condition, data.delivery, artifact);
    const initial_prompt_hash = await promptHash(messages);
    if (data.phase === "TASK" && data.delivery === "USER_PASTE_WITH_HANDSHAKE") {
      if (data.priorAssistant == null) return { ok: false, error: "Handshake reply is missing." };
      messages = [
        ...messages,
        { role: "assistant", content: data.priorAssistant },
        { role: "user", content: data.task },
      ];
    }

    if (!takeBudget()) {
      return {
        ok: false,
        error: `Call budget is spent for this window (${LIVE.serverCallBudget} calls / ${LIVE.serverWindowMinutes} min). Open a stored run instead.`,
      };
    }

    const call = await recordCall(apiKey, messages, data.phase, data.reasoningEffort);
    return { ok: true, blocked: false, call, initial_prompt_hash };
  });
