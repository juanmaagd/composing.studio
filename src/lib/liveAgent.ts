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
export default class LiveAgent {
  private readonly editor: editor.IStandaloneCodeEditor;
  private readonly audioEl: HTMLAudioElement;
  private readonly callbacks: LiveAgentCallbacks;

  private state: LiveAgentState = "idle";
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
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

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      const pc = new RTCPeerConnection();
      this.pc = pc;

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

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.waitForIceGatheringComplete(pc);

      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) {
        throw new Error("Missing local SDP after ICE gathering completed");
      }

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

      const result = await response.json();
      const answerSdp = result?.transport?.sdp;
      if (!answerSdp) {
        throw new Error("Live session response is missing transport.sdp");
      }

      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      // Do NOT send session.start: the HTTP request above already started
      // the session. State flips to "live" once session.started arrives.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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

  private registerDataChannelListeners(dc: RTCDataChannel) {
    dc.addEventListener("message", (event) => {
      this.handleDataChannelMessage(event.data);
    });

    dc.addEventListener("close", () => {
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
