import { openPod } from "cascade-runtime";
import { sampleExport } from "cascade-runtime/samples";

const pod = await openPod("pods/alex", { title: "Alex Rivera" });
const folder = await sampleExport("alex-rivera", "x-e2");
console.log(await pod.look(folder)); // what the export holds; writes nothing

// Your app asks the person here whether these records are theirs, and stops on a no.
const brought = await pod.import(folder, { claimProfiles: (named) => named });
if (brought.refused) console.log(`Not brought in: ${brought.refused}`);

for (const row of await pod.ask("pod/My active allergies"))
  console.log(row.allergenName, row.criticality ?? "not stated", row.sources);
await pod.close();
