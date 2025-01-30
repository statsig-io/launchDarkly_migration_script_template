import "dotenv/config.js"; // this must be the first import to parse any `.env` files
import { extractLaunchDarklyFlags } from "./lib/etl/extract.mjs";
import { transformLaunchDarklyFlagsToStatSigFlags } from "./lib/etl/transform.mjs";
import { prepareStatsig, loadFlagsIntoStatSig } from "./lib/etl/load.mjs";
import { outputResults } from "./lib/reporter.mjs";

const launchDarklyProjects = process.argv.slice(2);
if (!launchDarklyProjects || launchDarklyProjects.length === 0) {
    console.error('Please provide at least one LaunchDarkly project key as an argument.');
    process.exit(1);
}

await prepareStatsig()
    .then(() => launchDarklyProjects)
    .then(extractLaunchDarklyFlags)
    .then(transformLaunchDarklyFlagsToStatSigFlags)
    .then(loadFlagsIntoStatSig)
    .then(outputResults)
    .catch(error => {
        console.error('Migration Error:', error);
    });
