const axios = require('axios');

const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const csvOutputPath = 'flag_migration_tracker.csv';
const csvWriter = createCsvWriter({
    path: csvOutputPath,
    header: [
        {id: 'migration_status', title: 'migration_status'},
        {id: 'ld_flag_name', title: 'ld_flag_name'},
        {id: 'statsig_gate_name', title: 'statsig_gate_name'},
        {id: 'ld_url', title: 'ld_url'},
        {id: 'statsig_url', title: 'statsig_url'},
        {id: 'ld_flag_key', title: 'ld_flag_key'},
        {id: 'statsig_id', title: 'statsig_id'},
        {id: 'ld_creation_date', title: 'ld_creation_date'},
        {id: 'statsig_created_time', title: 'statsig_created_time'}
    ]
});

// Environment variables for API keys and project/environment identifiers
const LAUNCHDARKLY_API_KEY = "XXXXXXXX";
const LAUNCHDARKLY_PROJECT_KEY = "default";
const STATSIG_API_KEY = "XXXXXXXXXX";
//This should match the LaunchDarkly environment 
// i.e. "production" => https://app.launchdarkly.com/default/production/features/test-feature-flag
const LAUNCHDARKLY_ENVIRONMENT = "production";
const TAG_NAME = 'Migration Script';

// API endpoints
const LD_API_BASE_URL = 'https://app.launchdarkly.com';
const STATSIG_API_BASE_URL = 'https://statsigapi.net/console/v1';

// Headers for LD API requests
const ldHeaders = { headers: { Authorization: LAUNCHDARKLY_API_KEY } };

// Headers for Statsig API requests
const statsigHeaders = {
    headers: {
        'STATSIG-API-KEY': STATSIG_API_KEY,
        'Content-Type': 'application/json',
    },
}

// Define operator types to match those expected by Statsig, corresponding to LaunchDarkly's operators.
const APIOperatorType = {
    NONE: 'none',
    STR_MATCHES: 'str_matches',
    VERSION_EQ: 'version_eq',
    VERSION_GTE: 'version_gte',
    VERSION_LTE: 'version_lte',
    VERSION_GT: 'version_gt',
    VERSION_LT: 'version_lt',
    LT: 'lt',
    LTE: 'lte',
    GT: 'gt',
    GTE: 'gte',
    BEFORE: 'before',
    AFTER: 'after',
    ANY: 'any',
    STR_CONTAINS_ANY: 'str_contains_any',
    STR_CONTAINS_NONE: 'str_contains_none'
}

// Escapes special characters in a string to be used in a regex.
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Fetch LaunchDarkly flags
async function fetchLaunchDarklyFlags() {
    try {
        const response = await axios.get(`${LD_API_BASE_URL}/api/v2/flags/${LAUNCHDARKLY_PROJECT_KEY}?env=${LAUNCHDARKLY_ENVIRONMENT}`, ldHeaders);
        console.log('Fetched LaunchDarkly flags successfully.');
        return response.data.items;
    } catch (error) {
        console.error('Error fetching flags from LaunchDarkly:', error);
        throw new Error('Failed to fetch flags from LaunchDarkly.');
    }
}

// Maps LaunchDarkly operators to Statsig operators, considering negation.
function mapOperator(operator, negate) {

    const mapping = {
        lessThan: negate ? APIOperatorType.GTE : APIOperatorType.LT,
        lessThanOrEqual: APIOperatorType.LTE,
        greaterThan: negate ? APIOperatorType.LTE : APIOperatorType.GT,
        greaterThanOrEqual: APIOperatorType.GTE,
        before: APIOperatorType.BEFORE,
        after: APIOperatorType.AFTER,
        in: negate ? APIOperatorType.NONE : APIOperatorType.ANY,
        matches: negate ? APIOperatorType.NONE : APIOperatorType.STR_MATCHES,
        contains: negate ? APIOperatorType.STR_CONTAINS_NONE : APIOperatorType.STR_CONTAINS_ANY,
        semVerEqual: APIOperatorType.VERSION_EQ,
        startsWith: APIOperatorType.STR_MATCHES,
        endsWith: APIOperatorType.STR_MATCHES,
        segmentMatch: APIOperatorType.NONE
    };

    // Logic to throw an error if the operator is not supported
    if (mapping.hasOwnProperty(operator)) {
        return mapping[operator];
    } else {
        throw new Error(`Unsupported operator: ${operator}`);
    }
}

// Maps target values based on the operator, applying necessary transformations for regex patterns.
function mapTargetsForOperator(operator, values) {
    switch (operator) {
        case 'startsWith':
            return values.map(v => `^${escapeRegex(v.toString())}`);
        case 'endsWith':
            return values.map(v => `${escapeRegex(v.toString())}$`);
        case 'segmentMatch':
            // Assuming segmentMatch values directly map to segment identifiers.
            return values.map(v => `segment:${v}`);
        default:
            // For operators like 'in', the values are used as-is.
            return values;
    }
}

// Maps attributes to Statsig condition types, adding any necessary extra information for custom fields.
function mapType(attribute) {
    /*
    
    Make sure you check this section out and customize it!
    This is where you can adjust the trait mappings!

    */
    const typeMapping = {
        country: 'country',
        email: 'email',
        key: 'user_id',
        ip: 'ip_address',
        segmentMatch: 'passes_segment'
        // Extend this mapping based on your attributes in LaunchDarkly.
    };

    if (typeMapping[attribute]) {
        return { type: typeMapping[attribute] };
    } else {
        // For attributes not explicitly mapped, treat them as custom fields.
        return { type: 'custom_field', field: attribute };
    }
}

// Determines the pass percentage for a rule based on whether it specifies a variation or a rollout.
function getPassPercentage(rule, enabledIndex) {
    if (rule.rollout) {
        // For rollouts, find the weight of the enabled variation and convert to a percentage.
        const variation = rule.rollout.variations[0];
        return variation.weight / 1000; // Assuming weights are out of 100,000 for a percentage.
    } else if (rule.variation == 0) {
        // If a specific variation is set, determine if it matches the enabled variation.
        return rule.variation === enabledIndex ? 100 : 0;
    } else {
        throw new Error('Variation or rollout must be specified in rule');
    }
}

// Translates a LaunchDarkly rule into one or more Statsig rules, accounting for complex segment matches.
function translateLaunchDarklyRule(rule, enabledIndex) {

    // Translate the launch darkly pass percentage to statsig pass percentage
    const passPercentage = getPassPercentage(rule, enabledIndex);

    // Translate each clause within the rule to a Statsig condition.
    const conditions = rule.clauses.map(clause => translateLaunchDarklyClause(clause));

    return {
        name: rule.description || 'Imported rule',
        passPercentage,
        conditions,
        environment: 'production' // Assuming a single, production environment for simplicity.
    };
}

// Translates a LaunchDarkly clause into a Statsig condition.
function translateLaunchDarklyClause(clause) {
    const { type, field } = mapType(clause.attribute);
    let returnVal = {
        type,
        operator: mapOperator(clause.op, clause.negate),
        targetValue: mapTargetsForOperator(clause.op, clause.values)
    };

    if (type == 'custom_field') {
        returnVal.field = field;
    }

    return returnVal;
}

// Function to translate a LaunchDarkly flag to a Statsig feature flag or dynamic config
function translateLDFlagToStatsig(flag) {
    // Determine if the flag is a simple feature flag or a dynamic config based on its variations
    const isBooleanFlag = flag.variations.every(variation => typeof variation.value === 'boolean');
    const isFlagTemporary = flag.temporary ? 'PERMANENT' : 'TEMPORARY';

    // Prepare a common structure for both feature flags and dynamic configs
    const statsigFeatureFlag = {
        name: flag.key,
        description: flag.description,
        type: isFlagTemporary,
        // Default enabled state and rules will be added here
        enabled: flag.environments[LAUNCHDARKLY_ENVIRONMENT].on,
        rules: [],
        tags: [TAG_NAME]
    };

    // Translate variations and targeting rules from LaunchDarkly to Statsig format
    if (!isBooleanFlag) {
        return false;
    } else {
        // For each targeting rule in LaunchDarkly, create a corresponding rule in Statsig
        flag.environments[LAUNCHDARKLY_ENVIRONMENT].rules.forEach(ldRule => {
            const statsigRule = translateLaunchDarklyRule(ldRule, flag.variations);
            statsigFeatureFlag.rules.push(statsigRule);
        });

        return statsigFeatureFlag;
    }
}

// Fetches all feature gates from launch darkly
async function fetchLaunchDarklyFeatureGate(projectKey, featureFlagKey) {
    const url = `${LD_API_BASE_URL}/api/v2/flags/${projectKey}/${featureFlagKey}`;

    try {
        const response = await axios.get(url, ldHeaders);
        //console.log(`Fetched feature gate "${featureFlagKey}" successfully.`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching feature gate "${featureFlagKey}" from LaunchDarkly:`, error);
        throw new Error(`Failed to fetch feature gate "${featureFlagKey}" from LaunchDarkly.`);
    }
}

// Function to create a feature gate
async function createStatsigFeatureGate(featureGate) {
    try {
        const response = await axios.post(`${STATSIG_API_BASE_URL}/gates`, featureGate, statsigHeaders);
        return response.data;
    } catch (error) {
        console.error('Error creating feature gate:', error.response?.data);
        return false;
    }
}

//Ensure the TAG_NAME tag is created, and if not, create it
async function checkAndCreateTag(tagName) {
    try {
        // Step 1: Fetch existing tags to check if the tag already exists
        const tagsResponse = await axios.get(`${STATSIG_API_BASE_URL}/tags`, statsigHeaders);

        const tags = tagsResponse.data.data;
        const tagExists = tags.some(tag => tag.name === tagName);

        // Step 2: If the tag doesn't exist, create it
        if (!tagExists) {
            const createTagResponse = await axios.post(
                `${STATSIG_API_BASE_URL}/tags`,
                { name: tagName, description: "Flags migrated from the LD to Statsig migration script" },
                statsigHeaders,
            );

            console.log(`Tag "${tagName}" created successfully.`);
            return createTagResponse.data;
        } else {
            console.log(`Tag "${tagName}" already exists.`);
            return null;
        }
    } catch (error) {
        //console.error('Error checking or creating tag:', error);
        if (error.response.data.errors) {
            console.log("console.log(error.response.data.errors);");
            console.log(error.response.data.errors);
            console.log("console.log(error.response.data.errors);");
        }
        throw error;
    }
}

// deletes feature gates from Statsig with specified tagName - designed to help clean up a test/failed migration
async function deleteFeatureFlagsWithTag(tagName) {
    try {
        // Step 1: Fetch all feature flags
        const flagsResponse = await axios.get(`${STATSIG_API_BASE_URL}/gates`, statsigHeaders);

        const flags = flagsResponse.data.data;

        console.log("Found "+flags.length+" feature gates in Statsig.");

        // Step 2: Filter flags that have the specified tag
        const flagsToDelete = flags.filter(flag =>
            flag.tags.includes(tagName),
        );

        console.log("Found "+flagsToDelete.length+" feature gates tagged with '"+TAG_NAME+"'");

        // Step 3: Delete each flagged feature flag
        for (const flag of flagsToDelete) {
            await axios.delete(`${STATSIG_API_BASE_URL}/gates/${flag.id}`, statsigHeaders);
        }

        console.log('SUCCESS All feature gates tagged "'+TAG_NAME+'" have been deleted.');
    } catch (error) {
        console.error('FAILED deleting feature gates:', error.response?.data || error.message);
        throw error.response?.data || error.message;
    }
}

// Main function to translate and migrate flags
async function migrateFeatureFlags() {
    
    const ldFlags = await fetchLaunchDarklyFlags();
    let CSV_OUTPUT = [];
    await checkAndCreateTag(TAG_NAME);

    console.log("Found "+ldFlags.length+" LaunchDarkly flags. Preparing to import to Statsig!");

    for (const flag of ldFlags) {

        let CSV_OUTPUT_ROW = {
            ld_flag_name : "",
            ld_flag_key : "",
            ld_creation_date : "",
            ld_url : "",
            migration_status : "",
            statsig_id : "",
            statsig_url : "",
            statsig_gate_name : "",
            statsig_created_time : ""
        };

        try {

            // Fetch detailed flag information
            const detailedFlag = await fetchLaunchDarklyFeatureGate(LAUNCHDARKLY_PROJECT_KEY, flag.key);

            CSV_OUTPUT_ROW.ld_flag_name = detailedFlag.name;
            CSV_OUTPUT_ROW.ld_flag_key = detailedFlag.key;
            let  ld_creation_date = new Date(Number(detailedFlag.creationDate));
            CSV_OUTPUT_ROW.ld_creation_date = ld_creation_date.toLocaleString();
            CSV_OUTPUT_ROW.ld_url = "https://app.launchdarkly.com/default/"+LAUNCHDARKLY_ENVIRONMENT+"/features/"+detailedFlag.key;

            const statsigFeatureFlag = translateLDFlagToStatsig(detailedFlag);

            if (statsigFeatureFlag) {

                const statsigCreateResponse = await createStatsigFeatureGate(statsigFeatureFlag);

                if (statsigCreateResponse) {
                    CSV_OUTPUT_ROW.statsig_id = statsigCreateResponse.data.id;
                    CSV_OUTPUT_ROW.statsig_url = "https://console.statsig.com//gates/"+statsigCreateResponse.data.id;
                    CSV_OUTPUT_ROW.statsig_gate_name = statsigCreateResponse.data.name;
                    let  statsig_created_time = new Date(Number(statsigCreateResponse.data.createdTime));
                    CSV_OUTPUT_ROW.statsig_created_time = statsig_created_time.toLocaleString();
                    CSV_OUTPUT_ROW.migration_status = "SUCCESSFUL MIGRATION SCRIPT";
                    //console.log(`SUCCESS migrating the *"${detailedFlag.key}"* flag to Statsig!`);
                }else{
                    CSV_OUTPUT_ROW.migration_status = "FAILED MIGRATION SCRIPT";
                    //console.log(`FAILED migrating the *"${detailedFlag.key}"* flag to Statsig. Migration script failure.`);
                }
            } else {
                CSV_OUTPUT_ROW.migration_status = "NEEDS MANUAL MIGRATION FOR NON BOOLEAN FLAGS";
                //console.error(`FAILED processing flag *"${flag.key}"*:`, error);
            }

        } catch (error) {
            CSV_OUTPUT_ROW.migration_status = "FAILED MIGRATION SCRIPT";
            CSV_OUTPUT.push(CSV_OUTPUT_ROW);
            //console.error(`FAILED processing flag *"${flag.key}"*:`, error);
        }

        CSV_OUTPUT.push(CSV_OUTPUT_ROW);
    }

    console.log('Migration process completed.');

    csvWriter.writeRecords(CSV_OUTPUT)
    .then(() => {
        console.log('Flag migration results written to '+csvOutputPath);
    });

}


// Delete all flags with TAG_NAME and then migrate feature flags
// Use this to clean up a Statsig workspace after a migration attempt
//deleteFeatureFlagsWithTag(TAG_NAME)
    //.then(() => {
        // Call the main migration function after all flags have been deleted
        migrateFeatureFlags().catch(console.error);
    //})
    //.catch(console.error);

