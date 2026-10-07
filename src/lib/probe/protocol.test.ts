import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONDITIONS,
  CONTROL,
  DELIVERIES,
  DEMO,
  HANDSHAKE,
  PUBLIC_HANDSHAKE_PREFIX,
  PUBLIC_HASHES,
  TASK,
  assemble,
  demoBytes,
  inspectDemo,
  plannedCalls,
  promptHash,
  serializeMessages,
} from "./protocol.ts";

describe("three-lane public assembly", () => {
  it("matches published system-slot and pasted hashes", async () => {
    const artifact = await inspectDemo(demoBytes(false));
    assert.equal(artifact.status, "VALID");
    assert.equal(artifact.byte_length, 168);
    for (const delivery of ["SYSTEM_SLOT", "USER_PASTE"] as const) {
      for (const condition of CONDITIONS) {
        const hash = await promptHash(assemble(TASK, condition, delivery, artifact));
        assert.equal(hash, PUBLIC_HASHES[delivery][condition]);
      }
    }
  });

  it("matches published handshake prefixes and withholds the task", async () => {
    const artifact = await inspectDemo(demoBytes(false));
    for (const condition of CONDITIONS) {
      const messages = assemble(TASK, condition, "USER_PASTE_WITH_HANDSHAKE", artifact);
      const hash = await promptHash(messages);
      assert.ok(hash.startsWith(PUBLIC_HANDSHAKE_PREFIX[condition]));
      assert.equal(messages.at(-1)?.content, HANDSHAKE);
      const wire = new TextDecoder().decode(serializeMessages(messages));
      assert.equal(wire.includes(TASK), false);
    }
  });

  it("blocks context lanes on CRLF tamper without repairing bytes", async () => {
    const artifact = await inspectDemo(demoBytes(true));
    assert.equal(artifact.status, "INVALID");
    assert.equal(artifact.byte_length, 172);
    assert.ok(artifact.diagnostics.some((line) => line.includes("LF")));
    for (const delivery of DELIVERIES) {
      assert.equal(plannedCalls(delivery, false), delivery === "USER_PASTE_WITH_HANDSHAKE" ? 2 : 1);
      assert.throws(() => assemble(TASK, "FULL_INJECTOR", delivery, artifact));
    }
    assert.equal(plannedCalls("SYSTEM_SLOT", true), 3);
  });

  it("keeps baseline free of fixture and control text", async () => {
    const artifact = await inspectDemo(demoBytes(false));
    const messages = assemble(TASK, "BASELINE", "SYSTEM_SLOT", artifact);
    assert.deepEqual(messages, [{ role: "user", content: TASK }]);
    assert.equal(
      messages.some((m) => m.content === DEMO || m.content === CONTROL),
      false,
    );
  });
});
