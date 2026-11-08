import { writeFileSync } from "node:fs";
import { train } from "./model";
import { trainingSet } from "./training-data";

/** Deterministic: same data and seed, same weights, so the file only changes when training data does. */
const model = train(trainingSet());
writeFileSync(new URL("./weights.json", import.meta.url), JSON.stringify(model));
console.log(`Trained ${model.version} on ${trainingSet().length} synthetic samples; ${Object.keys(model.weights).length} weights.`);
