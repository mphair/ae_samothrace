// Recording plumbing -- phase 1 of plans/samothrace-map-consolidation.md.
// Wraps the two Bridge capabilities that landed specifically to support
// this (see that plan's §2/§3, confirmed against the real contract on
// 2026-10-11): `events` (desk.events.subscribe/onMessage, to know when
// Claude (Desk)'s record button is active) and `log` (desk.log.append/
// line, a named in-memory log an agent reads back with the
// desk_list_widget_logs / desk_query_widget_log MCP tools).
//
// Concatenated BEFORE samothrace-map.ts in tsconfig.json's own "files"
// array (these compile as global scripts, no import/export -- load
// order matters the same way script-tag order would) since the main
// element instantiates RecordingController, not the other way around.
// The full Window.desk Bridge-API shape lives here, in the first file,
// rather than split redundantly across both -- a second `interface
// Window { desk?: ... }` declaration in samothrace-map.ts would need to
// restate this one's members exactly to merge cleanly, which is just a
// second place to keep in sync for no benefit; every member either file
// needs is declared once, here, and both are checked together as one
// `tsc` program regardless of which file lists it.

// This project's bundled `tsc` predates the DOM lib's crypto.randomUUID()
// typing too (same gap as ResizeObserver in samothrace-map.ts), even
// though real browsers have long supported it -- declaration-merge the
// one method actually used rather than widen the whole Crypto type.
interface Crypto {
  randomUUID(): string;
}

interface Window {
  desk?: {
    self: {
      getLocalStorage(): Promise<{ data: Record<string, unknown> }>;
      setLocalStorage(data: Record<string, unknown>): Promise<{ ok: boolean }>;
      setSubtitle(text: string | null): Promise<{ ok: boolean }>;
      // Added for applyImageTransform (samothrace-map-agent-qa-tab.ts) --
      // an Installed Job gets neither a reliable cwd nor a reliable
      // DESK_PROJECT_DIR env var (see map-import-from-photo/main.py's own
      // _project_dir_and_slug comment), so a Bridge-triggered run needs to
      // pass the project directory explicitly via config_path. No
      // capability required for this call (confirmed against
      // desk/server/app.py: self.getManifest is the one capability-free
      // route). Only the one field this widget actually uses is declared
      // here -- the real response has more (id, name, capabilities, etc.).
      getManifest(): Promise<{ directory: string }>;
    };
    fs: {
      readFile(path: string): Promise<{ contents: string }>;
      // Added for samothrace-map-qa-panel.ts (phase 4) -- the Q&A tabs'
      // own durable answer-log files, never needed by anything before.
      writeFile(path: string, contents: string): Promise<{ ok: boolean }>;
    };
    state: {
      get(key: string): Promise<{ value: unknown; edit: unknown }>;
      set(key: string, value: unknown, edit?: unknown): Promise<{ ok: boolean }>;
    };
    events: {
      subscribe(names: string[]): Promise<{ ok: boolean }>;
      onMessage(callback: (name: string, payload: unknown, senderInstanceId: string) => void): void;
    };
    log: {
      // Both fire-and-forget per tempui-widget-logs.md: no promise, never
      // throws, so these return void here rather than Promise<...> --
      // callers should not await them.
      append(name: string, entries: Array<{ s: string; t?: number }>): void;
      line(name: string, s: string): void;
    };
    // Used by samothrace-map-stage-layers.ts (phase 2) to read the
    // pipeline-stage PNG snapshots -- declared here rather than in that
    // file because a second `interface Window { desk?: ... }` with a
    // different inline shape doesn't structurally merge with this one;
    // TS requires every redeclaration of the same property to match
    // exactly. One real declaration, here, covering every member any
    // file in this program needs, is simpler than trying to split it.
    documents: {
      open(path: string): Promise<{ handle: string }>;
      read(handle: string, opts: { offset: number; length: number }): Promise<{ data: string; eof: boolean }>;
      close(handle: string): Promise<{ closed: boolean }>;
    };
    // Added for samothrace-map-agent-qa-tab.ts's 'adjust-image-transform'
    // question -- "Lock In" calls this directly (capability
    // `installed_jobs`, declared in widget.json) to regenerate the real
    // tile layer the moment the user confirms their rotate/scale/tilt
    // adjustment, rather than requiring a separate agent-triggered step.
    // Bounded to 120s by Desk itself (see tempui-custom-widgets.md) --
    // the actual bake has run in a few seconds every time it's been
    // tried, comfortably inside that.
    installedJobs: {
      run(name: string, configPath?: string | null): Promise<{ ok: boolean; stdout: string; stderr: string; traceback: string }>;
    };
  };
}

// Real desk.events payloads Claude (Desk)'s own record button publishes
// (tempui-widget-logs.md, "Recording events and timecoded transcripts" --
// confirmed against a real dictated recording on 2026-10-11, see that
// plan doc's §2). `stopped_recording` fires even for a recording that
// captured no audio; a recording that never starts at all (no
// microphone) publishes neither event.
const RECORDING_STARTED_EVENT = 'recording';
const RECORDING_STOPPED_EVENT = 'stopped_recording';

interface RecordingStartedPayload {
  recording_id: string;
  started_at_ms: number;
}

interface RecordingStoppedPayload {
  recording_id: string;
  started_at_ms: number;
  stopped_at_ms: number;
}

// What this widget actually writes to its own log -- a log entry's own
// `s` is a plain string (desk.log has no structured-entry concept), so
// every call JSON-stringifies one of these into it. `recordingId` is
// included even though desk_query_widget_log's own time-range query
// already correlates entries to a recording -- tempui-widget-logs.md
// suggests it anyway, and it's cheap, useful context inline in the text
// an agent reads back without a second lookup.
interface RecordingLogEntry {
  recordingId: string;
  source: string; // e.g. "contours-layer", "qa:label-review", "qa:minor-bands", "qa:contour-connector"
  type: string; // e.g. "hover", "click", "answer", "show-me", "layer-toggle"
  payload: unknown; // keep SMALL -- entry text truncates at 4096 chars; ids/positions/short labels, never raw geometry
}

// One log per widget INSTANCE, not one per tab/event-type (Desk caps at
// 500 distinct logs process-wide, shared across every widget) -- minted
// once and persisted via getLocalStorage/setLocalStorage so it survives
// a reload, the exact pattern tempui-widget-logs.md's own worked example
// uses.
const LOG_NAME_PREFIX = 'samothrace-map-';

class RecordingController {
  private logName: string | null = null;
  private activeRecordingId: string | null = null;
  private changeListeners: Array<(recordingId: string | null) => void> = [];

  get isRecording(): boolean {
    return this.activeRecordingId !== null;
  }

  get recordingId(): string | null {
    return this.activeRecordingId;
  }

  // Called once, early, during the widget's own init() -- see this
  // class's own file-header comment for why subscribing as early as
  // possible matters (a 'recording' event could in principle arrive
  // before the rest of startup finishes).
  async init(): Promise<void> {
    const desk = window.desk;
    if (!desk) return;

    const { data } = await desk.self.getLocalStorage();
    let logId = typeof data.recordingLogId === 'string' ? data.recordingLogId : null;
    if (!logId) {
      logId = crypto.randomUUID().slice(0, 8);
      await desk.self.setLocalStorage({ ...data, recordingLogId: logId });
    }
    this.logName = LOG_NAME_PREFIX + logId;

    await desk.events.subscribe([RECORDING_STARTED_EVENT, RECORDING_STOPPED_EVENT]);
    desk.events.onMessage((name, payload) => {
      if (name === RECORDING_STARTED_EVENT) {
        this.activeRecordingId = (payload as RecordingStartedPayload).recording_id;
        this.notifyChange();
      } else if (name === RECORDING_STOPPED_EVENT) {
        // Guard against an unrelated widget's own stopped_recording somehow
        // arriving out of order relative to a start we never saw -- only
        // clear if it matches the recording we actually think is active
        // (or clear unconditionally if we never got a matching start, so
        // this never gets stuck "recording" forever on a missed event).
        const stoppedId = (payload as RecordingStoppedPayload).recording_id;
        if (this.activeRecordingId === null || this.activeRecordingId === stoppedId) {
          this.activeRecordingId = null;
          this.notifyChange();
        }
      }
    });
  }

  // Register a callback fired whenever recording starts or stops (the
  // new recordingId, or null once stopped) -- e.g. to show/hide the
  // recording indicator. Called immediately with the current value too,
  // so a listener registered after init() already ran doesn't have to
  // separately ask for the starting state.
  onChange(callback: (recordingId: string | null) => void): void {
    this.changeListeners.push(callback);
    callback(this.activeRecordingId);
  }

  private notifyChange(): void {
    for (const cb of this.changeListeners) cb(this.activeRecordingId);
  }

  // Appends one entry to this instance's own recording log -- but ONLY
  // while a recording is actually active; returns whether it did, so a
  // caller that also needs an answer to survive outside a recording
  // (see plans/samothrace-map-consolidation.md §5.2) knows to fall back
  // to its own durable file instead. Outside a recording, everything
  // other than a Q&A answer is simply not logged at all (meaningless
  // without a transcript to correlate against) -- this method doesn't
  // special-case that; callers decide what "not logged" should mean for
  // their own entry type.
  log(source: string, type: string, payload: unknown): boolean {
    const desk = window.desk;
    if (!desk || !this.logName || this.activeRecordingId === null) return false;
    const entry: RecordingLogEntry = { recordingId: this.activeRecordingId, source, type, payload };
    desk.log.line(this.logName, JSON.stringify(entry));
    return true;
  }
}
