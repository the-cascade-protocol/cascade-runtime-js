import { stdout } from "node:process";
import { nodeHost, podApi, worthALook } from "cascade-runtime/app";
import { loadSample } from "cascade-runtime/samples";

await loadSample("alex-rivera", "pods/alex-rivera");
const api = podApi(nodeHost({ folder: "pods" }));

const { answers } = await api.answers({ pod: "alex-rivera" });
for (const { sentence, tag } of worthALook(answers))
  stdout.write(`${JSON.stringify({ sentence, tag })}\n`);
await api.close();
