// Capture causal events before a background timer or a later field can erase them.
// No DOM scans and no page actions. A worker acknowledgement means durable capture.
export function createEventStream({ context, send, defer, cancel }) {
  let queue = [],
    running = false,
    scheduled = false,
    retry,
    disposed = false;
  const sequences = new Map();
  let sequence = 0,
    dropped = 0,
    lastAck = 0,
    error = "";
  function append(event) {
    if (disposed) return event;
    const metadata = context();
    if (!metadata) return event;
    sequence = (sequences.get(metadata.runId) || 0) + 1;
    sequences.set(metadata.runId, sequence);
    const entry = { ...event, sequence };
    queue.push({ metadata, entry });
    if (queue.length > 512) {
      queue.shift();
      dropped++;
    }
    schedule();
    return entry;
  }
  function schedule() {
    if (scheduled || running || disposed) return;
    scheduled = true;
    void Promise.resolve().then(() => {
      scheduled = false;
      return flush();
    });
  }
  async function flush() {
    if (running || disposed || !queue.length) return;
    running = true;
    const head = queue[0],
      batch = [];
    for (const row of queue) {
      if (row.metadata.runId !== head.metadata.runId || batch.length === 32)
        break;
      batch.push(row);
    }
    try {
      const report = {
        ...head.metadata,
        observedAt: batch.at(-1).entry.at,
        eventOnly: true,
        fields: [],
        unansweredContainers: [],
        events: batch.map((row) => row.entry),
        droppedEvents: dropped,
      };
      const reply = await send(report);
      if (reply?.error || (reply?.data?.ok !== true && reply?.ok !== true))
        throw Error("capture_unacknowledged");
      if (disposed) return;
      const accepted = new Set(batch);
      queue = queue.filter((row) => !accepted.has(row));
      lastAck = report.observedAt;
      error = "";
    } catch {
      error = "capture_unacknowledged";
    } finally {
      running = false;
      if (!disposed && queue.length) {
        if (error) {
          if (!retry)
            retry = defer(() => {
              retry = undefined;
              schedule();
            }, 1000);
        } else schedule();
      }
    }
  }
  return {
    append,
    flush,
    status: () => ({ pending: queue.length, dropped, lastAck, error }),
    clear() {
      disposed = true;
      queue = [];
      if (retry) cancel(retry);
    },
  };
}
