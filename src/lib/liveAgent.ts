import type { editor } from "monaco-editor/esm/vs/editor/editor.api";

/** Connection state reported to the UI via `onStateChange`. */
export type LiveAgentState =
  | "idle"
  | "connecting"
  | "live"
  | "closing"
  | "error";

/** Callbacks used to report state, errors, and tool activity to the UI. */
export type LiveAgentCallbacks = {
  readonly onStateChange?: (state: LiveAgentState) => unknown;
  readonly onError?: (message: string) => unknown;
  readonly onSummary?: (summary: string) => unknown;
};

type ReplaceScoreArgs = {
  abc: string;
  summary?: string;
};

const DATA_CHANNEL_LABEL = "oai-events";
const MICROPHONE_TIMEOUT_MS = 15_000;
const SCORE_CONTEXT_DEBOUNCE_MS = 400;
const ICE_GATHERING_TIMEOUT_MS = 10_000;
const SESSION_CLOSE_TIMEOUT_MS = 5_000;

let eventIdCounter = 0;

/** Generates a unique event id for outgoing data channel commands. */
function nextEventId(): string {
  eventIdCounter += 1;
  return `evt_${Date.now()}_${eventIdCounter}`;
}

/**
 * Connects the browser to OpenAI's GPT-Live API over WebRTC and applies
 * `replace_score` tool calls from the delegated backend model directly to a
 * Monaco editor instance. Framework-agnostic: no React imports.
 *
 * Because the shared editor is wired through the Rustpad OT client, any edit
 * applied here via `editor.executeEdits` propagates to every collaborator
 * exactly like a normal keystroke.
 */
const t0 = Date.now();
/** Timestamped tracing for the connection sequence. Visible in the browser console. */
function trace(step: string, detail?: unknown) {
  const ms = String(Date.now() - t0).padStart(6);
  if (detail === undefined) console.log(`[live ${ms}ms] ${step}`);
  else console.log(`[live ${ms}ms] ${step}`, detail);
}

export default class LiveAgent {
  private readonly editor: editor.IStandaloneCodeEditor;
  private readonly audioEl: HTMLAudioElement;
  private readonly callbacks: LiveAgentCallbacks;

  private state: LiveAgentState = "idle";
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private scoreContextTimer?: ReturnType<typeof setTimeout>;
  private scoreChangeHandle?: { dispose(): void };
  private localStream?: MediaStream;

  constructor(
    editorInstance: editor.IStandaloneCodeEditor,
    audioEl: HTMLAudioElement,
    callbacks: LiveAgentCallbacks = {}
  ) {
    this.editor = editorInstance;
    this.audioEl = audioEl;
    this.callbacks = callbacks;
  }

  getState(): LiveAgentState {
    return this.state;
  }

  private setState(state: LiveAgentState) {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  /** Starts a GPT-Live session. Must be called from a user gesture. */
  async start(): Promise<void> {
    if (this.state === "connecting" || this.state === "live") {
      return;
    }
    this.setState("connecting");
    trace("start() called");

    try {
      trace("requesting microphone...");
      // getUserMedia never settles when the permission prompt is dismissed
      // rather than answered, which looks exactly like a frozen button. Fail
      // loudly instead so the cause is visible.
      this.localStream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "Microphone permission was never granted. Check the microphone " +
                    "icon in the address bar, and confirm the browser has microphone " +
                    "access in your operating system's privacy settings."
                )
              ),
            MICROPHONE_TIMEOUT_MS
          )
        ),
      ]);
      trace("microphone granted", this.localStream.getAudioTracks().map((t) => t.label));

      const pc = new RTCPeerConnection();
      this.pc = pc;
      pc.addEventListener("connectionstatechange", () => trace("pc.connectionState", pc.connectionState));
      pc.addEventListener("iceconnectionstatechange", () => trace("pc.iceConnectionState", pc.iceConnectionState));

      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) {
          this.audioEl.srcObject = stream;
        }
      };

      // Data channel and its listeners must exist before the offer is
      // created, per OpenAI's GPT-Live connection sequence.
      const dc = pc.createDataChannel(DATA_CHANNEL_LABEL);
      this.dc = dc;
      this.registerDataChannelListeners(dc);

      trace("creating offer");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      trace("waiting for ICE gathering");
      await this.waitForIceGatheringComplete(pc);
      trace("ICE gathering done", pc.iceGatheringState);

      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) {
        throw new Error("Missing local SDP after ICE gathering completed");
      }

      trace("POST /api/live-session", `sdp ${localSdp.length} bytes`);
      const response = await fetch("/api/live-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: localSdp }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Live session request failed (${response.status}): ${detail}`
        );
      }

      trace("session created, HTTP " + response.status);
      const result = await response.json();
      const answerSdp = result?.transport?.sdp;
      if (!answerSdp) {
        throw new Error("Live session response is missing transport.sdp");
      }

      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      trace("remote description applied -- now waiting for session.started on the data channel");

      // Do NOT send session.start: the HTTP request above already started
      // the session. State flips to "live" once session.started arrives.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trace("FAILED", message);
      this.setState("error");
      this.callbacks.onError?.(message);
      await this.teardown();
      throw err;
    }
  }

  /** Ends the GPT-Live session and releases local media/connection state. */
  async stop(): Promise<void> {
    if (this.state === "idle") {
      return;
    }
    this.setState("closing");

    if (this.dc && this.dc.readyState === "open") {
      const closed = this.waitForSessionClosed();
      this.dc.send(JSON.stringify({ type: "session.close" }));
      await closed;
    }

    await this.teardown();
    this.setState("idle");
  }

  private waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        pc.removeEventListener("icegatheringstatechange", onChange);
        clearTimeout(timer);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === "complete") {
          finish();
        }
      };
      pc.addEventListener("icegatheringstatechange", onChange);
      const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
    });
  }

  private waitForSessionClosed(
    timeoutMs = SESSION_CLOSE_TIMEOUT_MS
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.dc?.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve();
      };
      const onMessage = (event: MessageEvent) => {
        const message = this.parseMessage(event.data);
        if (message?.type === "session.closed") {
          finish();
        }
      };
      this.dc?.addEventListener("message", onMessage);
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Push the current score to the backend as quiet context.
   *
   * The backend only receives the spoken transcript, so without this it has no
   * idea what "it" refers to in "make it lower" and regenerates a melody from
   * scratch. session.thinking.append is the documented channel for background
   * context; it is not spoken aloud. The 500-token cap is ample for a score.
   */
  private sendScoreContext() {
    if (!this.dc || this.dc.readyState !== "open" || this.state !== "live") {
      return;
    }
    const abc = this.editor.getModel()?.getValue() ?? "";
    const content = abc.trim()
      ? `The score currently in the shared editor is:\n\n${abc}\n\nUse this exact document as the basis for any change the user asks for.`
      : "The shared editor is currently empty. The next request starts a new score.";

    trace("-> session.thinking.append (score context)", `${abc.length} chars`);
    this.dc.send(
      JSON.stringify({
        type: "session.thinking.append",
        event_id: nextEventId(),
        delegation_id: null,
        content,
      })
    );
  }

  /** Re-send score context, debounced, whenever the document changes. */
  private scheduleScoreContext() {
    if (this.scoreContextTimer !== undefined) {
      clearTimeout(this.scoreContextTimer);
    }
    this.scoreContextTimer = setTimeout(() => {
      this.scoreContextTimer = undefined;
      this.sendScoreContext();
    }, SCORE_CONTEXT_DEBOUNCE_MS);
  }

  private registerDataChannelListeners(dc: RTCDataChannel) {
    dc.addEventListener("open", () => trace("data channel OPEN"));
    dc.addEventListener("error", (e) => trace("data channel ERROR", e));

    dc.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        trace("<- " + parsed.type, parsed.type === "error" ? parsed : undefined);
      } catch {
        trace("<- unparseable data channel message", event.data);
      }
      this.handleDataChannelMessage(event.data);
    });

    dc.addEventListener("close", () => {
      trace("data channel CLOSED");
      if (this.state === "live" || this.state === "connecting") {
        this.setState("idle");
      }
    });

    dc.addEventListener("error", () => {
      this.setState("error");
      this.callbacks.onError?.("GPT-Live data channel error");
    });
  }

  private parseMessage(raw: unknown): any {
    if (typeof raw !== "string") {
      return undefined;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private handleDataChannelMessage(raw: unknown) {
    const message = this.parseMessage(raw);
    if (!message || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "session.started":
        // Seed the backend with the score as soon as the session is usable,
        // and keep it in sync as the document changes.
        setTimeout(() => this.sendScoreContext(), 0);
        if (!this.scoreChangeHandle) {
          this.scoreChangeHandle = this.editor
            .getModel()
            ?.onDidChangeContent(() => this.scheduleScoreContext());
        }
        this.setState("live");
        return;
      case "session.closed":
        this.setState("idle");
        return;
      case "error":
        this.setState("error");
        this.callbacks.onError?.(
          message.error?.message ?? "GPT-Live session error"
        );
        return;
      case "response.event":
        // Delegated Responses events arrive wrapped: dispatch on
        // envelope.event.type, never on a top-level "response.*" type.
        this.handleDelegatedEvent(message.event);
        return;
      default:
        return;
    }
  }

  private handleDelegatedEvent(event: any) {
    if (!event || event.type !== "response.output_item.done") {
      // Forwarded lifecycle snapshots (including response.completed) carry
      // an empty response.output — function calls are read exclusively
      // from response.output_item.done, never inferred from that snapshot.
      return;
    }

    const item = event.item;
    if (item?.type === "function_call" && item.call_id && item.name) {
      this.executeFunctionCall(item.call_id, item.name, item.arguments ?? "");
    }
  }

  private executeFunctionCall(callId: string, name: string, rawArgs: string) {
    let output: string;
    try {
      if (name === "replace_score") {
        const args: ReplaceScoreArgs = JSON.parse(rawArgs);
        this.applyReplaceScore(args);
        output = JSON.stringify({ status: "applied" });
      } else {
        output = JSON.stringify({
          status: "error",
          error: `Unknown tool: ${name}`,
        });
      }
    } catch (err) {
      output = JSON.stringify({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.sendFunctionCallOutput(callId, output);
  }

  private applyReplaceScore(args: ReplaceScoreArgs) {
    const model = this.editor.getModel();
    if (!model || typeof args.abc !== "string") {
      return;
    }
    this.editor.executeEdits("voice-agent", [
      {
        range: model.getFullModelRange(),
        text: args.abc,
        forceMoveMarkers: true,
      },
    ]);
    if (args.summary) {
      this.callbacks.onSummary?.(args.summary);
    }
  }

  private sendFunctionCallOutput(callId: string, output: string) {
    if (!this.dc || this.dc.readyState !== "open") {
      return;
    }

    // Appending the function output does not continue the response on its
    // own -- response.create must be sent explicitly afterwards.
    this.dc.send(
      JSON.stringify({
        type: "response.item.create",
        event_id: nextEventId(),
        item: {
          type: "function_call_output",
          call_id: callId,
          output,
        },
      })
    );

    this.dc.send(
      JSON.stringify({
        type: "response.create",
        event_id: nextEventId(),
      })
    );
  }

  private async teardown() {
    if (this.scoreContextTimer !== undefined) {
      clearTimeout(this.scoreContextTimer);
      this.scoreContextTimer = undefined;
    }
    this.scoreChangeHandle?.dispose();
    this.scoreChangeHandle = undefined;

    if (this.dc) {
      this.dc.close();
      this.dc = undefined;
    }
    if (this.pc) {
      for (const sender of this.pc.getSenders()) {
        sender.track?.stop();
      }
      this.pc.close();
      this.pc = undefined;
    }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = undefined;
    }
    this.audioEl.srcObject = null;
  }
}
