import { createObjectCsvWriter } from 'csv-writer';

function getFlagMaintainer(flag) {
    return flag._maintainer
        ? `${flag._maintainer.firstName} ${flag._maintainer.lastName}`
        : 'Unknown';
}

/**
 * 
 * @param {{detectedEnvironments: string[], loadResults: {ldFlag: any, statsigFeatureFlag: any, error: Error}[]}} loadResults 
 */
export async function outputResults({ loadResults, detectedEnvironments }) {
    const csvOutputPath = 'flag_migration_tracker.csv';
    const csvWriter = createObjectCsvWriter({
        path: csvOutputPath,
        header: [
            { id: 'migration_status', title: 'migration_status' },
            { id: 'ld_flag_name', title: 'ld_flag_name' },
            { id: 'ld_project', title: 'ld_project' },
            { id: 'statsig_gate_name', title: 'statsig_gate_name' },
            { id: 'ld_url', title: 'ld_url' },
            { id: 'statsig_url', title: 'statsig_url' },
            { id: 'ld_flag_key', title: 'ld_flag_key' },
            { id: 'statsig_id', title: 'statsig_id' },
            { id: 'ld_creation_date', title: 'ld_creation_date' },
            { id: 'statsig_created_time', title: 'statsig_created_time' },
            { id: 'maintainer', title: 'maintainer' }
        ]
    });
    const CSV_OUTPUT = loadResults.map(({ ldFlag, statsigFeatureFlag, error }) => {
        const CSV_OUTPUT_ROW = {
            ld_flag_name: ldFlag.name,
            ld_flag_key: ldFlag.key,
            ld_project: ldFlag.project,
            ld_creation_date: new Date(Number(ldFlag.creationDate)).toLocaleString(),
            ld_url: detectedEnvironments.map(environmentName => `https://app.launchdarkly.com/${ldFlag.environments[environmentName]._site.href}`).join(" "),
            migration_status: "",
            statsig_id: "",
            statsig_url: "",
            statsig_gate_name: "",
            statsig_created_time: "",
            maintainer: getFlagMaintainer(ldFlag)
        };
        if (statsigFeatureFlag) {
            CSV_OUTPUT_ROW.migration_status = "SUCCESSFUL MIGRATION SCRIPT";
            CSV_OUTPUT_ROW.statsig_id = statsigFeatureFlag.id;
            CSV_OUTPUT_ROW.statsig_url = `https://console.statsig.com//gates/${statsigFeatureFlag.id}`;
            CSV_OUTPUT_ROW.statsig_gate_name = statsigFeatureFlag.name;
            CSV_OUTPUT_ROW.statsig_created_time = new Date(Number(statsigFeatureFlag.createdTime)).toLocaleString();
        } else if (!statsigFeatureFlag && !error) {
            CSV_OUTPUT_ROW.migration_status = "NEEDS MANUAL MIGRATION FOR NON BOOLEAN FLAGS";
        } else {
            CSV_OUTPUT_ROW.migration_status = error.message;
        }
        return CSV_OUTPUT_ROW;
    });

    csvWriter.writeRecords(CSV_OUTPUT)
        .then(() => {
            console.log('Flag migration results written to ' + csvOutputPath);
        });
}