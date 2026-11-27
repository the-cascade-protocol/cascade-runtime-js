import { stdout } from "node:process";
import { nodeHost, podApi } from "cascade-runtime/app";
import { loadSample } from "cascade-runtime/samples";

await loadSample("alex-rivera", "pods/alex-rivera", { through: "J1" });
const api = podApi(nodeHost({ folder: "pods" }));

const { rows } = await api.ask({
  pod: "alex-rivera",
  question: "pod/My active allergies",
});
for (const row of rows) stdout.write(`${JSON.stringify(row)}\n`);
await api.close();
