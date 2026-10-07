import { useEffect, useMemo, useState } from "react";
import {
  CONDITIONS,
  CONDITION_LABEL,
  CONTROL,
  DELIVERIES,
  DELIVERY_LABEL,
  DEMO,
  LIVE,
  TASK,
  type Condition,
  type Delivery,
  type ExperimentRecord,
  type LaneRecord,
  type ReasoningEffort,
  assemble,
  demoBytes,
  fingerprint,
  inspectDemo,
  plannedCalls,
  promptHash,
  publicHashNote,
  recheckCalls,
  sha256Text,
  validateTask,
} from "@/lib/probe/protocol";
import { runLane } from "@/lib/probe/run-probe";

const HISTORY_KEY = "three-lane-live-history";
const SESSION_KEY = "three-lane-live-count";

type Preview = {
  valid: boolean;
  diagnostics: string[];
  byteLength: number;
  hashes: Partial<Record<Condition, string>>;
};

function loadHistory(): ExperimentRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ExperimentRecord[];
    return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function loadSessionCount(): number {
  try {
    const n = Number(sessionStorage.getItem(SESSION_KEY) ?? "0");
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function ProbeApp() {
  const [task, setTask] = useState(TASK);
  const [delivery, setDelivery] = useState<Delivery>("SYSTEM_SLOT");
  const [tamper, setTamper] = useState(false);
  const [consent, setConsent] = useState(false);
  const [effort, setEffort] = useState<ReasoningEffort>("low");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [running, setRunning] = useState(false);
  const [active, setActive] = useState<Condition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [experiment, setExperiment] = useState<ExperimentRecord | null>(null);
  const [stored, setStored] = useState(false);
  const [recheck, setRecheck] = useState<string | null>(null);
  const [history, setHistory] = useState<ExperimentRecord[]>([]);
  const [sessionCount, setSessionCount] = useState(0);

  useEffect(() => {
    setHistory(loadHistory());
    setSessionCount(loadSessionCount());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const artifact = await inspectDemo(demoBytes(tamper));
      const hashes: Preview["hashes"] = {};
      const taskOk = task.trim().length > 0 && task.length <= 4000;
      if (taskOk) {
        for (const condition of CONDITIONS) {
          if (condition !== "BASELINE" && artifact.status !== "VALID") continue;
          hashes[condition] = await promptHash(assemble(task, condition, delivery, artifact));
        }
      }
      if (!cancelled) {
        setPreview({
          valid: artifact.status === "VALID",
          diagnostics: artifact.diagnostics,
          byteLength: artifact.byte_length,
          hashes,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task, delivery, tamper]);

  const calls = plannedCalls(delivery, preview?.valid ?? !tamper);
  const taskOk = useMemo(() => {
    try {
      validateTask(task);
      return true;
    } catch {
      return false;
    }
  }, [task]);
  const capped = sessionCount >= LIVE.sessionExperimentCap;
  const canRun = taskOk && consent && !running && !capped && preview != null;

  async function onRun() {
    if (!canRun) return;
    setRunning(true);
    setError(null);
    setRecheck(null);
    setStored(false);
    const artifact = await inspectDemo(demoBytes(tamper));
    const { text: _text, ...artifactPublic } = artifact;
    let record: ExperimentRecord = {
      schema_version: LIVE.schema,
      experiment_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      ended_at: "",
      classification:
        "LIVE_GROK_VIEWPORT. Not workbench-experiment-v2. Not a quality score. Fixture is the public DEMO text.",
      resolution: "INSUFFICIENT_EVIDENCE",
      evaluation: null,
      provider: "xai",
      requested_model: LIVE.model,
      reasoning_effort: effort,
      max_completion_tokens: LIVE.maxCompletionTokens,
      temperature: null,
      seed: null,
      task,
      task_sha256: await sha256Text(task),
      delivery_mode: delivery,
      tamper_crlf: tamper,
      artifact: artifactPublic,
      runs: CONDITIONS.map((condition) => ({
        condition,
        status: "NOT_RUN",
        errors: [],
        initial_prompt_hash: null,
        calls: [],
        result: null,
      })),
      status: "PARTIAL",
    };
    setExperiment(record);
    const remember = (next: ExperimentRecord) => {
      record = next;
      setExperiment(next);
      const storedRuns = [next, ...loadHistory().filter((item) => item.experiment_id !== next.experiment_id)].slice(0, 6);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(storedRuns));
      setHistory(storedRuns);
    };
    let counted = false;
    const countOnce = () => {
      if (counted) return;
      counted = true;
      const count = loadSessionCount() + 1;
      sessionStorage.setItem(SESSION_KEY, String(count));
      setSessionCount(count);
    };
    const patch = (condition: Condition, next: Partial<LaneRecord>) => {
      remember({
        ...record,
        runs: record.runs.map((lane) => (lane.condition === condition ? { ...lane, ...next } : lane)),
      });
    };

    try {
      let stop = false;
      for (const condition of CONDITIONS) {
        if (stop) {
          patch(condition, { status: "NOT_RUN", errors: ["Stopped after an earlier call failed."] });
          continue;
        }
        setActive(condition);
        const firstPhase = delivery === "USER_PASTE_WITH_HANDSHAKE" ? "HANDSHAKE" : "TASK";
        const first = await runLane({
          data: {
            task,
            delivery,
            tamper,
            consent: true,
            reasoningEffort: effort,
            condition,
            phase: firstPhase,
            priorAssistant: null,
          },
        });
        if (!first.ok) {
          setError(first.error);
          patch(condition, { status: "FAILED", errors: [first.error] });
          stop = true;
          continue;
        }
        if (first.blocked) {
          patch(condition, { status: "BLOCKED", errors: first.diagnostics });
          continue;
        }
        countOnce();
        patch(condition, {
          initial_prompt_hash: first.initial_prompt_hash,
          calls: [first.call],
        });
        if (first.call.error_type) {
          patch(condition, {
            status: "FAILED",
            errors: [first.call.error_type],
            initial_prompt_hash: first.initial_prompt_hash,
            calls: [first.call],
          });
          stop = true;
          continue;
        }
        let taskCall = first.call;
        if (delivery === "USER_PASTE_WITH_HANDSHAKE") {
          const second = await runLane({
            data: {
              task,
              delivery,
              tamper,
              consent: true,
              reasoningEffort: effort,
              condition,
              phase: "TASK",
              priorAssistant: first.call.response ?? "",
            },
          });
          if (!second.ok) {
            setError(second.error);
            patch(condition, {
              status: "FAILED",
              errors: [second.error],
              initial_prompt_hash: first.initial_prompt_hash,
              calls: [first.call],
            });
            stop = true;
            continue;
          }
          if (second.blocked) {
            patch(condition, { status: "BLOCKED", errors: second.diagnostics });
            continue;
          }
          taskCall = second.call;
          const calls = [first.call, second.call];
          if (second.call.error_type) {
            patch(condition, {
              status: "FAILED",
              errors: [second.call.error_type],
              initial_prompt_hash: first.initial_prompt_hash,
              calls,
            });
            stop = true;
            continue;
          }
          patch(condition, {
            status: "SUCCEEDED",
            errors: [],
            initial_prompt_hash: first.initial_prompt_hash,
            calls,
            result: taskCall.response,
          });
          continue;
        }
        patch(condition, {
          status: "SUCCEEDED",
          errors: [],
          initial_prompt_hash: first.initial_prompt_hash,
          calls: [first.call],
          result: taskCall.response,
        });
      }
      const statuses = record.runs.map((lane) => lane.status);
      const status = statuses.every((item) => item === "SUCCEEDED")
        ? "COMPLETED"
        : statuses.some((item) => item === "SUCCEEDED" || item === "BLOCKED")
          ? "PARTIAL"
          : "FAILED";
      remember({ ...record, status, ended_at: new Date().toISOString() });
    } catch {
      setError("The connection dropped before that call finished. Lanes already returned are kept. Nothing was retried.");
      const touched = record.runs.some((lane) => lane.status !== "NOT_RUN" || lane.calls.length > 0);
      if (touched) remember({ ...record, ended_at: new Date().toISOString() });
    } finally {
      setActive(null);
      setRunning(false);
    }
  }

  function openStored(record: ExperimentRecord) {
    setExperiment(record);
    setStored(true);
    setError(null);
    setRecheck(null);
  }

  async function onRecheck() {
    if (!experiment) return;
    const problems: string[] = [];
    for (const lane of experiment.runs) {
      const mismatches = await recheckCalls(lane.calls);
      for (const item of mismatches) problems.push(`${lane.condition} ${item}`);
    }
    setRecheck(problems.length === 0 ? "Stored message hashes still match." : `Mismatch: ${problems.join(", ")}`);
  }

  function onExport() {
    if (!experiment) return;
    const blob = new Blob([JSON.stringify(experiment, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `three-lane-${experiment.experiment_id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    setHistory([]);
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">
      <header className="mb-6">
        <p className="text-sm text-muted">Live viewport</p>
        <h1 className="mt-1 text-2xl font-medium tracking-tight text-fg">Three-Lane Probe</h1>
        <p className="mt-3 max-w-prose text-base leading-normal text-muted">
          One question. Three prompts. Grok answers each one. This does not score the answers.
        </p>
        <p className="mt-3 text-sm leading-normal">
          <a
            className="text-accent underline underline-offset-2"
            href="https://github.com/donaldtuttle/three-lane-probe"
          >
            Source
          </a>
          <span className="text-subtle"> · </span>
          <a
            className="text-accent underline underline-offset-2"
            href="https://github.com/donaldtuttle/prompt-engineering-workbench"
          >
            Python harness
          </a>
        </p>
      </header>

      <aside className="mb-6 rounded-xl border border-line bg-surface p-4 text-sm leading-normal text-muted">
        <p>Not the Python harness. Not a QOFT result. Resolution stays insufficient evidence.</p>
        <p className="mt-2">
          The length lane repeats the word stone so it matches the public demo's fixed length.
          That is not meaningless text, and it is not xAI's tokenizer.
        </p>
      </aside>

      <form
        className="mb-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void onRun();
        }}
      >
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-fg">Question</span>
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
            rows={4}
            maxLength={4000}
            className="w-full resize-y rounded-lg border border-line bg-inset px-3 py-3 text-base leading-normal text-fg outline-none focus:border-accent"
          />
        </label>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-fg">How the fixture is delivered</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {DELIVERIES.map((mode) => {
              const on = delivery === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setDelivery(mode)}
                  className={
                    "min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors duration-150 " +
                    (on
                      ? "border-accent bg-accent text-accent-fg"
                      : "border-line bg-surface text-fg")
                  }
                >
                  <span className="block font-medium">{DELIVERY_LABEL[mode]}</span>
                  <span className={"mt-1 block font-mono text-xs " + (on ? "text-accent-fg" : "text-subtle")}>
                    {mode}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-fg">Thinking</legend>
          <div className="grid grid-cols-2 gap-2">
            {(["low", "medium"] as const).map((level) => {
              const on = effort === level;
              return (
                <button
                  key={level}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setEffort(level)}
                  className={
                    "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors duration-150 " +
                    (on ? "border-accent bg-accent text-accent-fg" : "border-line bg-surface text-fg")
                  }
                >
                  {level === "low" ? "Low" : "Medium"}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-sm leading-normal text-subtle">
            {effort === "low"
              ? "Low is the default here. High is not offered."
              : "Medium thinks longer and costs more. Still not a score."}
          </p>
        </fieldset>

        <label className="flex min-h-11 items-start gap-3 text-sm leading-normal text-fg">
          <input
            type="checkbox"
            checked={tamper}
            onChange={(event) => setTamper(event.target.checked)}
            className="mt-1 size-4 accent-accent"
          />
          <span>CRLF tamper. Context lanes should block. The bytes are not repaired.</span>
        </label>

        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-sm font-medium text-fg">
            {calls} live {calls === 1 ? "call" : "calls"} · {LIVE.model}
          </p>
          <p className="mt-2 font-mono text-xs leading-normal text-subtle">
            reasoning {effort} · max {LIVE.maxCompletionTokens} visible tokens · temperature omitted · seed omitted
          </p>
          <p className="mt-2 text-sm leading-normal text-muted">
            Fixture {preview == null ? "…" : preview.valid ? `valid · ${preview.byteLength} bytes` : `invalid · ${preview.byteLength} bytes`}.
            This tab: {sessionCount}/{LIVE.sessionExperimentCap} live runs. One call at a time, so a drop keeps the lanes that already came back.
          </p>
          {preview && !preview.valid ? (
            <p className="mt-2 text-sm leading-normal text-warn">{preview.diagnostics.join(" ")}</p>
          ) : null}
        </div>

        <label className="flex min-h-11 items-start gap-3 text-sm leading-normal text-fg">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            className="mt-1 size-4 accent-accent"
          />
          <span>Run this on my xAI quota. I understand the replies are not a test result.</span>
        </label>

        <button
          type="submit"
          disabled={!canRun}
          className="min-h-11 w-full rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg transition-opacity duration-150 disabled:bg-surface disabled:text-subtle"
        >
          {running ? "Running" : capped ? "Tab limit reached" : `Run ${calls} ${calls === 1 ? "call" : "calls"}`}
        </button>
        {!taskOk ? <p className="text-sm text-warn">The question needs 1 to 4000 non-blank characters.</p> : null}
        {capped ? (
          <p className="text-sm leading-normal text-muted">
            Four live runs are the cap for this tab. Stored runs below do not call the model.
          </p>
        ) : null}
        {error ? <p className="text-sm leading-normal text-bad">{error}</p> : null}
      </form>

      <section className="space-y-3" aria-label="Lanes">
        {CONDITIONS.map((condition) => (
          <LaneCard
            key={condition}
            condition={condition}
            task={task}
            delivery={delivery}
            tamper={tamper}
            preview={preview}
            experiment={experiment}
            running={running}
            active={active === condition}
          />
        ))}
      </section>

      {experiment ? (
        <section className="mt-6 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-base font-medium text-fg">Record</h2>
          <p className="mt-2 text-sm leading-normal text-muted">
            {running ? "One call at a time." : stored ? "Opened from this browser. No new model call." : "Latest run."}{" "}
            {experiment.status}. {experiment.resolution}. Evaluation is empty.
          </p>
          <p className="mt-2 break-all font-mono text-xs text-subtle">{experiment.experiment_id}</p>
          {recheck ? <p className="mt-2 text-sm leading-normal text-fg">{recheck}</p> : null}
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => void onRecheck()}
              className="min-h-11 rounded-lg border border-line bg-inset px-3 text-sm font-medium text-fg"
            >
              Recheck hashes
            </button>
            <button
              type="button"
              onClick={onExport}
              className="min-h-11 rounded-lg border border-line bg-inset px-3 text-sm font-medium text-fg"
            >
              Export JSON
            </button>
          </div>
        </section>
      ) : null}

      <section className="mt-6">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-base font-medium text-fg">Stored in this browser</h2>
          {history.length > 0 ? (
            <button type="button" onClick={clearHistory} className="min-h-11 text-sm text-muted">
              Clear
            </button>
          ) : null}
        </div>
        {history.length === 0 ? (
          <p className="text-sm leading-normal text-subtle">No stored runs yet. A live run stays on this device only.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((record) => (
              <li key={record.experiment_id}>
                <button
                  type="button"
                  onClick={() => openStored(record)}
                  className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-left"
                >
                  <span className="block text-sm text-fg">
                    {DELIVERY_LABEL[record.delivery_mode]} · {record.status}
                  </span>
                  <span className="mt-1 block font-mono text-xs text-subtle">
                    {record.created_at.slice(0, 19)} · {record.reasoning_effort}
                    {record.tamper_crlf ? " · tamper" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function LaneCard({
  condition,
  task,
  delivery,
  tamper,
  preview,
  experiment,
  running,
  active,
}: {
  condition: Condition;
  task: string;
  delivery: Delivery;
  tamper: boolean;
  preview: Preview | null;
  experiment: ExperimentRecord | null;
  running: boolean;
  active: boolean;
}) {
  const lane = experiment?.runs.find((item) => item.condition === condition) ?? null;
  const hash = lane?.initial_prompt_hash ?? preview?.hashes[condition] ?? null;
  const blocked = preview != null && condition !== "BASELINE" && !preview.valid;
  const note = publicHashNote(task, delivery, tamper, condition, hash);
  const context =
    condition === "FULL_INJECTOR" ? DEMO : condition === "NEUTRAL_LENGTH_CONTROL" ? CONTROL : null;

  return (
    <article className="rounded-xl border border-line bg-surface p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium text-fg">{CONDITION_LABEL[condition]}</h2>
        <span className="font-mono text-xs text-subtle">{condition}</span>
      </header>
      <p className="mt-3 break-all font-mono text-xs leading-normal text-muted">
        {hash ? fingerprint(hash) : running ? "Calling" : blocked ? "Blocked" : "…"}
      </p>
      {hash ? <p className="mt-1 break-all font-mono text-xs text-subtle">{hash}</p> : null}
      {note ? <p className="mt-2 text-sm text-ok">{note}</p> : null}
      {blocked ? (
        <p className="mt-2 text-sm leading-normal text-warn">No call. The fixture hash does not match.</p>
      ) : null}
      {running && active ? <p className="mt-2 text-sm text-muted">Calling Grok.</p> : null}
      {lane?.status === "NOT_RUN" && lane.errors[0] ? (
        <p className="mt-2 text-sm text-muted">{lane.errors[0]}</p>
      ) : null}
      {lane?.status === "FAILED" ? (
        <p className="mt-2 text-sm text-bad">Call failed ({lane.errors.join(", ")}). Nothing was retried.</p>
      ) : null}
      {lane?.calls.map((call) => (
        <div key={call.phase + call.prompt_hash} className="mt-4 border-t border-line pt-3">
          <p className="text-sm font-medium text-fg">{call.phase === "HANDSHAKE" ? "Handshake" : "Question"}</p>
          <p className="mt-1 font-mono text-xs text-subtle">
            {call.returned_model ?? "no model string"}
            {call.finish_reason ? ` · ${call.finish_reason}` : ""}
            {call.usage?.total_tokens != null ? ` · ${call.usage.total_tokens} tokens` : ""}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-normal text-fg">
            {call.response && call.response.length > 0 ? call.response : call.error_type ? "No reply stored." : "Empty reply."}
          </p>
        </div>
      ))}
      {context && !blocked ? (
        <details className="mt-4">
          <summary className="min-h-11 cursor-pointer text-sm text-muted">Context that will be sent</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-inset p-3 font-mono text-xs leading-normal text-muted">
            {context}
          </pre>
        </details>
      ) : null}
    </article>
  );
}
