import { evictDiagnosticEvent } from "./diagnostic-evidence.js";

// Capture and legacy migration share the wire budget. A previously valid
// snapshot can expand when each field becomes a separate event.
export function boundEventLog(data) {
  const bytes = () => new TextEncoder().encode(JSON.stringify(data)).byteLength;
  let changed = false;
  while (data.events.length > 1500 || bytes() > 150000) {
    if (!data.events.length)
      throw Error("Diagnostic metadata exceeds the storage budget");
    evictDiagnosticEvent(data.events);
    data.truncated = changed = true;
  }
  return changed;
}
