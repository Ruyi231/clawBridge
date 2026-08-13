import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start")
    send({ id: message.id, result: { thread: { id: "thread-crash" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-crash" } } });
    setTimeout(() => process.exit(17), 5);
  }
});
