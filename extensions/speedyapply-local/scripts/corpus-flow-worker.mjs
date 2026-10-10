// Private JSON-lines IPC. Profiles/requests stay on stdin/stdout pipes; this
// worker has no provider client and never logs values to stderr or disk.
import { createInterface } from "node:readline";
import { replayCorpusFlow } from "./corpus-flow.mjs";
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
for (;;) {
  const input = await lines.next();
  if (input.done) break;
  try {
    const command = JSON.parse(input.value);
    const result = await replayCorpusFlow({
      ...command,
      generate: async (request) => {
        send({ type: "generate", request });
        const line = await lines.next();
        if (line.done) throw Error("Replay provider disconnected");
        const response = JSON.parse(line.value);
        if (response.type !== "answer")
          throw Error("Unexpected replay protocol message");
        if (response.error) throw Error("Replay provider failed");
        return response.result;
      },
    });
    send({ type: "result", result });
  } catch (error) {
    send({ type: "failure", errorType: error?.name || "Error" });
  }
}
