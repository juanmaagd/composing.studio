const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const source = ts.transpileModule(fs.readFileSync("src/lib/liveAgent.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
function fixture(extra = {}) {
  const exports = {};
  const context = { exports, console: { log() {} }, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, ...extra };
  vm.runInNewContext(source, context);
  const states = [], activities = [], errors = [], edits = [], muted = [];
  const model = { getValue: () => "X:1\nK:C\nCDEF|", getFullModelRange: () => ({}), onDidChangeContent: () => ({ dispose() {} }) };
  const audio = { srcObject: null };
  const agent = new exports.default({ getModel: () => model, executeEdits: (_, value) => { edits.push(value); return true; } }, audio, { onStateChange: (x) => states.push(x), onActivityChange: (x) => activities.push(x), onError: (x) => errors.push(x), onMutedChange: (x) => muted.push(x) });
  const emit = (message) => agent.handleDataChannelMessage(JSON.stringify(message));
  return { agent, states, activities, errors, edits, muted, audio, emit };
}
test("delegated lifecycle reports thinking, tool work and completion", async () => {
  const f = fixture();
  f.emit({ type: "session.started" });
  f.emit({ type: "session.delegation.created" });
  assert.equal(f.activities.at(-1), "thinking");
  f.emit({ type: "response.event", event: { type: "response.output_item.added", item: { type: "function_call" } } });
  assert.equal(f.activities.at(-1), "working");
  f.emit({ type: "response.event", event: { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "replace_score", arguments: JSON.stringify({ abc: "X:1\nK:C\nCDEF|" }) } } });
  assert.equal(f.edits.length, 1);
  f.emit({ type: "response.event", event: { type: "response.completed" } });
  assert.equal(f.activities.at(-1), "listening");
  await f.agent.stop();
});
test("mute disables microphone tracks without muting received audio", async () => {
  const f = fixture();
  const track = { enabled: true, stop() {} };
  f.agent.localStream = { getAudioTracks: () => [track], getTracks: () => [track] };
  f.agent.setMuted(true);
  assert.equal(track.enabled, false);
  assert.equal(f.muted.at(-1), true);
  assert.equal(f.audio.muted, undefined);
  f.agent.setMuted(false);
  assert.equal(track.enabled, true);
});
test("cancel releases a late permission stream and never opens a peer", async () => {
  let grant, stopped = 0;
  const f = fixture({ navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) } }, AudioContext: class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } } });
  const pending = f.agent.start();
  assert.equal(f.agent.getState(), "connecting");
  await f.agent.stop();
  grant({ getTracks: () => [{ stop() { stopped++; } }] });
  await pending;
  assert.equal(stopped, 1);
  assert.equal(f.agent.getState(), "idle");
});
test("unexpected close releases microphone and exposes recovery error", () => {
  const f = fixture();
  let stopped = 0;
  f.agent.state = "live";
  f.agent.localStream = { getAudioTracks: () => [], getTracks: () => [{ stop() { stopped++; } }] };
  f.emit({ type: "session.closed" });
  assert.equal(f.agent.getState(), "error");
  assert.equal(stopped, 1);
  assert.match(f.errors[0], /Retry/);
});
test("old channel messages and close cannot affect a replacement session", () => {
  const f = fixture();
  const handlers = {};
  const old = { addEventListener: (type, callback) => { handlers[type] = callback; } };
  f.agent.registerDataChannelListeners(old);
  f.agent.dc = {};
  f.agent.state = "live";
  handlers.message({ data: JSON.stringify({ type: "error", error: { message: "old" } }) });
  handlers.close();
  assert.equal(f.agent.getState(), "live");
  assert.equal(f.errors.length, 0);
});
test("permission failure is recoverable and releases transport resources", async () => {
  const f = fixture({ navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error("Permission denied")) } }, AudioContext: class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } } });
  await assert.rejects(f.agent.start(), /Permission denied/);
  assert.equal(f.agent.getState(), "error");
  assert.match(f.errors[0], /Permission denied/);
  assert.equal(f.agent.audioContext, undefined);
  await f.agent.stop();
  assert.equal(f.agent.getState(), "idle");
});
test("connection watchdog reports a stuck session and stops late microphone capture", async () => {
  const timers = [];
  let grant, stopped = 0;
  const f = fixture({ setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {}, navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) } }, AudioContext: class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } } });
  const pending = f.agent.start();
  timers.find((timer) => timer.delay === 30000).callback();
  grant({ getTracks: () => [{ stop() { stopped++; } }] });
  await pending;
  assert.equal(f.agent.getState(), "error");
  assert.match(f.errors[0], /timed out/);
  assert.equal(stopped, 1);
});
