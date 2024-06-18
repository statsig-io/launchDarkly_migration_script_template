const axios = require('axios');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const csvOutputPath = 'flag_migration_tracker.csv';
const csvWriter = createCsvWriter({
    path: csvOutputPath,
    header: [
        { id: 'migration_status', title: 'migration_status' },
        { id: 'ld_flag_name', title: 'ld_flag_name' },
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

// Environment variables for API keys and project/environment identifiers
const LAUNCHDARKLY_API_KEY = "";
// Default usually works for non enterprise accounts
// Enterprise accounts will need to plug in their distinct project key
const LAUNCHDARKLY_PROJECT_KEY = "default";
const STATSIG_API_KEY = "";
// This tag will be placed on all of your Statsig gates that are imported
// It will be used to clean before migration runs and can be used for your internal accounting
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
    STR_CONTAINS_NONE: 'str_contains_none',
    SEGMENT: 'passes_segment'
}

/* 

(OPTIONAL) translateUserContextAttributeToStatsigUnitId

For example, let's say you're using a clause that looks like this in LaunchDarkly:
{
    "_id": "8b8030c3-ca55-2d64-5513-080c59b2c1cf",
    "attribute": "customer_id",
    "contextKind": "user",
    "negate": false,
    "op": "in",
    "values": [
        1234
    ]
}
By populating the array below, you will migrate this to be used as an identifier itself, instead
of using it as a user attribute. This way, you can randomize on it and run analysis on customer_id entities in aggregate.

More on using customIDs in Statsig: https://docs.statsig.com/guides/experiment-on-custom-id-types
*/
// const translateUserContextAttributeToStatsigUnitId = ['customer_id'];
const translateUserContextAttributeToStatsigUnitId = [];

// We will use this to store state on which environments we autodetect
let detectedEnvironments = [];

// Set to true if you want to hard code the response from the get all LD flags API call
let prefillApiResponses = false;
// See code block below on vars to supply
//prefillApiResponses = true;
/* 

Plug in a cached response to GET "/api/v2/flags/${LAUNCHDARKLY_PROJECT_KEY}?summary=0" into flagsFromLdApiCallResponse
For example it should be structured like this:

const flagsFromLdApiCallResponse = {
    "_links": {
        "self": {
            "href": "/api/v2/flags/${LAUNCHDARKLY_PROJECT_KEY}?summary=0",
            "type": "application/json"
        }
    },
    "items": [...],
    "totalCount": 777
};
*/
const flagsFromLdApiCallResponse = false;


// Escapes special characters in a string to be used in a regex.
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Fetch LaunchDarkly flags
async function fetchLaunchDarklyFlags() {

    let fetchLaunchDarklyFlagsReturnVal;

    // if you want to supply the LD API response without making the network request to LD
    if (prefillApiResponses) {
        fetchLaunchDarklyFlagsReturnVal = flagsFromLdApiCallResponse.items;
    } else {

        try {
            const response = await axios.get(`${LD_API_BASE_URL}/api/v2/flags/${LAUNCHDARKLY_PROJECT_KEY}?summary=0}`, ldHeaders);
            console.log('Fetched LaunchDarkly flags successfully.');
            fetchLaunchDarklyFlagsReturnVal = response.data.items;
        } catch (error) {
            console.error('Error fetching flags from LaunchDarkly:', error);
            throw new Error('Failed to fetch flags from LaunchDarkly.');
        }

    }

    detectedEnvironments = getUniqueEnvironmentKeys(fetchLaunchDarklyFlagsReturnVal);

    return fetchLaunchDarklyFlagsReturnVal;
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
        segmentMatch: APIOperatorType.SEGMENT
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
        case 'in':
            //LD allows you to run in clause against array of booleans
            //Statsig doesn't, must coerce to string
            let returnValues = [];
            values.map(function(value){
                if(typeof value != "string" && typeof value != "number"){
                    returnValues.push(JSON.stringify(value));
                }else{
                    returnValues.push(value);
                }
            });
            return returnValues;
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

    if (translateUserContextAttributeToStatsigUnitId.includes(attribute)) {
        // We will be mapping this to a custom_id
        return { type: 'unit_id', field: attribute, customID: attribute };
    } else if (typeMapping[attribute]) {
        return { type: typeMapping[attribute] };
    } else {
        // For attributes not explicitly mapped, treat them as custom fields.
        return { type: 'custom_field', field: attribute };
    }
}

// Determines the pass percentage for a rule based on whether it specifies a variation or a rollout.
function getPassPercentage(rule) {
    if (rule.rollout) {
        // For rollouts, find the weight of the enabled variation and convert to a percentage.
        const variation = rule.rollout.variations[0];
        return variation.weight / 1000; // Assuming weights are out of 100,000 for a percentage.
    } else if (rule.variation == 0) {
        // Assuming rule 0 is always true in this case based on the sample i looked at
        return 100;
    } else if (rule.variation == 1) {
        // Assuming rule 1 is always false in this case based on the sample i looked at
        return 0;
    } else {
        throw new Error('Variation or rollout must be specified in rule');
    }
}

// Translates a LaunchDarkly rule into one or more Statsig rules, accounting for complex segment matches.
function translateLaunchDarklyRule(rule, environmentName, environmentFlag, ruleIndex) {

    let passPercentage;

    if (!environmentFlag.on) {
        //flag is off, display "offVariation"
        passPercentage = environmentFlag.offVariation == 0 ? 100 : 0;
    } else {
        // Translate the launch darkly pass percentage to statsig pass percentage
        passPercentage = getPassPercentage(rule);
    }

    // Translate each clause within the rule to a Statsig condition.
    const conditions = []
    rule.clauses.map(clause => conditions.push(translateLaunchDarklyClause(clause)) );

    var ruleName = '(' + environmentName + ') ' + (rule.description ?  rule.description+' import'+ruleIndex : 'import'+ruleIndex);

    return {
        name: ruleName,
        passPercentage,
        conditions,
        environments: [environmentName]
    };
}

// Translates a LaunchDarkly clause into a Statsig condition.
function translateLaunchDarklyClause(clause) {
    const { type, field, customID } = mapType(clause.attribute);
    let returnVal = {
        type,
        operator: mapOperator(clause.op, clause.negate),
        targetValue: mapTargetsForOperator(clause.op, clause.values)
    };

    if (type == 'custom_field') {
        returnVal.field = field;
    }

    if (type == 'unit_id') {
        returnVal.customID = customID;
    }

    return returnVal;
}

// Function to translate a LaunchDarkly flag to a Statsig feature flag or dynamic config
function translateLDFlagToStatsig(flag) {
    // Determine if the flag is a simple feature flag or a dynamic config based on its variations
    const isBooleanFlag = flag.kind == 'boolean';

    // Translate variations and targeting rules from LaunchDarkly to Statsig format
    if (!isBooleanFlag) {
        return false;
    } else {
        const isFlagTemporary = flag.temporary ? 'PERMANENT' : 'TEMPORARY';

        let statsigFeatureFlagOverrides = [];

        // Prepare a common structure for both feature flags and dynamic configs
        const statsigFeatureFlag = {
            name: flag.key,
            description: flag.description,
            type: isFlagTemporary,
            // Default enabled state and rules will be added here
            isEnabled: false,
            rules: [],
            tags: [TAG_NAME]
        };

        //get and manage the tags
        flag.tags.map(function (tagName) {
            statsigFeatureFlag.tags.push(tagName);
        });

        // For each environment in LaunchDarkly, create a corresponding overrides and rules in Statsig
        detectedEnvironments.map(function (environmentName) {

            //If atleast one environment is on, enable the feature flag in Statsig
            if (flag.environments[environmentName].on) {
                statsigFeatureFlag.isEnabled = true;
            }

            //If there are overrides manage them
            if (flag.environments[environmentName].targets.length > 0) {
                // Start building override object to send to statsig
                let environmentOverride = {
                    environment: environmentName,
                    unitID: 'userID',
                    passingIDs: [],
                    failingIDs: []
                };

                // Build the override object
                flag.environments[environmentName].targets.forEach(overrideTarget => {
                    if (overrideTarget.variation == 0) {
                        environmentOverride.passingIDs = overrideTarget.values;
                    } else if (overrideTarget.variation == 1) {
                        environmentOverride.failingIDs = overrideTarget.values;
                    }
                });

                statsigFeatureFlagOverrides.push(environmentOverride);

            }

            //manage the rules
            //sending rule index to avoind 'Duplicate rule name(s) given' error for many unnamed rules
            let ruleIndex = 0;
            flag.environments[environmentName].rules.forEach(ldRule => {
                const statsigRule = translateLaunchDarklyRule(ldRule, environmentName, flag.environments[environmentName], ruleIndex);
                statsigFeatureFlag.rules.push(statsigRule);
                ruleIndex++;
            });

            //manage the fall through rules
            const statsigFallthroughRule = translateLaunchDarklyFallthroughRule(environmentName, flag.environments[environmentName]);
            statsigFeatureFlag.rules.push(statsigFallthroughRule);
        });

        const arrProduction = statsigFeatureFlag.rules.filter(rule => rule.environments.indexOf("production") != -1);
        const arrNonProduction = statsigFeatureFlag.rules.filter(rule => rule.environments.indexOf("production") == -1);
        statsigFeatureFlag.rules = [...arrProduction, ...arrNonProduction];

        return { statsigFeatureFlag, statsigFeatureFlagOverrides };
    }
}

// Function to create a feature gate
async function createStatsigFeatureGate(featureGate) {
    try {
        const response = await axios.post(`${STATSIG_API_BASE_URL}/gates`, featureGate, statsigHeaders);
        return response.data;
    } catch (error) {
        console.error('Error creating feature gate named "' + featureGate.name + '" -', error.response?.data);
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
                { name: tagName, description: "Tags migrated from the LD to Statsig migration script" },
                statsigHeaders,
            );

            console.log(`Tag "${tagName}" created successfully.`);
            return createTagResponse.data;
        } else {
            //console.log(`Tag "${tagName}" already exists.`);
            return null;
        }
    } catch (error) {
        //console.error('Error checking or creating tag:', error);
        if (error.response.data.errors) {
            console.log(`Error creating Tag "${tagName}".`);
            console.log(error.response.data.errors);
        }
        throw error;
    }
}

//Same as above but for an array
async function checkAndCreateTags(arrayOfTagNames) {
    arrayOfTagNames.map(async function (tagName) {
        await checkAndCreateTag(tagName);
    });
}

// deletes feature gates from Statsig with specified tagName - designed to help clean up a test/failed migration
async function deleteFeatureFlagsWithTag(tagName) {
    try {
        // Step 1: Fetch all feature flags
        const flagsResponse = await axios.get(`${STATSIG_API_BASE_URL}/gates`, statsigHeaders);

        const flags = flagsResponse.data.data;

        console.log("Found " + flags.length + " feature gates in Statsig.");

        // Step 2: Filter flags that have the specified tag
        const flagsToDelete = flags.filter(flag =>
            flag.tags.includes(tagName),
        );

        console.log("Found " + flagsToDelete.length + " feature gates tagged with '" + TAG_NAME + "'");

        // Step 3: Delete each flagged feature flag
        for (const flag of flagsToDelete) {
            await axios.delete(`${STATSIG_API_BASE_URL}/gates/${flag.id}`, statsigHeaders);
        }

        console.log('SUCCESS All Statsig feature flags tagged "' + TAG_NAME + '" have been cleaned up.');
    } catch (error) {
        console.error('FAILED deleting feature gates:', error.response?.data || error.message);
        throw error.response?.data || error.message;
    }
}

function getUniqueEnvironmentKeys(array) {
    const uniqueKeys = new Set();

    array.forEach(item => {
        const environments = item.environments;
        if (environments) {
            Object.keys(environments).forEach(envKey => {
                uniqueKeys.add(envKey);
            });
        }
    });

    return Array.from(uniqueKeys);
}

async function addStatsigOverrides(overrides, gate_id) {
    try {
        let formattedOverridePayload = {
            passingUserIDs: [],
            failingUserIDs: [],
            environmentOverrides: overrides
        }
        const overrideResponse = await axios.post(`${STATSIG_API_BASE_URL}/gates/${gate_id}/overrides`, formattedOverridePayload, statsigHeaders);
        //console.log(`Overrides for "${gate_id}" created.`);
        return true;

    } catch (error) {
        if (error.response.data.errors) {
            console.log(`Error creating Overrides for "${gate_id}".`);
            console.log(error.response.data.errors);
        }
        throw error;
    }
}

function translateLaunchDarklyFallthroughRule(environmentName, environmentFlag) {

    var ruleName = '(' + environmentName + ') Fall through imported rule';

    const fallthroughRule = {
        name: ruleName,
        passPercentage: 0,
        conditions: [{ "type": "public" }],
        environments: [environmentName]
    };

    if(!environmentFlag.on){
        fallthroughRule.passPercentage = environmentFlag.offVariation == 0 ? 100 : 0;
    }else if (environmentFlag.fallthrough.rollout) {
        //if traffic is being routed to variation 0, which represents true/on
        if (environmentFlag.fallthrough.rollout.variations[0].weight != 0) {
            fallthroughRule.passPercentage = environmentFlag.fallthrough.rollout.variations[0].weight / 1000;
        }
    } else {

        if (environmentFlag.fallthrough.variation == 0) {
            // Assuming rule 0 is always true in this case based on the sample i looked at
            fallthroughRule.passPercentage = 100;
        } else if (environmentFlag.fallthrough.variation == 1) {
            // Assuming rule 1 is always false in this case based on the sample i looked at
            fallthroughRule.passPercentage = 0;
        }

    }

    return fallthroughRule;
}

// Main function to translate and migrate flags
async function migrateFeatureFlags() {

    const ldFlags = await fetchLaunchDarklyFlags();
    let CSV_OUTPUT = [];
    await checkAndCreateTag(TAG_NAME);

    console.log("Found " + ldFlags.length + " LaunchDarkly flags. Preparing to import to Statsig!");

    for (const flag of ldFlags) {

        console.log("Working on importing "+flag.name+" flag...");

        let CSV_OUTPUT_ROW = {
            ld_flag_name: "",
            ld_flag_key: "",
            ld_creation_date: "",
            ld_url: "",
            migration_status: "",
            statsig_id: "",
            statsig_url: "",
            statsig_gate_name: "",
            statsig_created_time: "",
            maintainer: ""
        };

        try {

            CSV_OUTPUT_ROW.maintainer = flag._maintainer.firstName + " " + flag._maintainer.lastName;
            CSV_OUTPUT_ROW.ld_flag_name = flag.name;
            CSV_OUTPUT_ROW.ld_flag_key = flag.key;
            let ld_creation_date = new Date(Number(flag.creationDate));
            CSV_OUTPUT_ROW.ld_creation_date = ld_creation_date.toLocaleString();
            CSV_OUTPUT_ROW.ld_url = "";

            // Get urls for all environments
            detectedEnvironments.map(function (environmentName) {
                CSV_OUTPUT_ROW.ld_url = CSV_OUTPUT_ROW.ld_url + "https://app.launchdarkly.com/" + flag.environments[environmentName]._site.href + "  ";
            });

            //make sure all the LD tags are created in statsig
            await checkAndCreateTags(flag.tags);
            const { statsigFeatureFlag, statsigFeatureFlagOverrides } = translateLDFlagToStatsig(flag);

            if (statsigFeatureFlag) {

                const statsigCreateResponse = await createStatsigFeatureGate(statsigFeatureFlag);

                if (statsigCreateResponse) {

                    //
                    //Add the overrides using statsigFeatureFlagOverrides and addStatsigOverrides method
                    if (statsigFeatureFlagOverrides.length > 0) {
                        await addStatsigOverrides(statsigFeatureFlagOverrides, statsigCreateResponse.data.id);
                    }
                    //

                    CSV_OUTPUT_ROW.statsig_id = statsigCreateResponse.data.id;
                    CSV_OUTPUT_ROW.statsig_url = "https://console.statsig.com//gates/" + statsigCreateResponse.data.id;
                    CSV_OUTPUT_ROW.statsig_gate_name = statsigCreateResponse.data.name;
                    let statsig_created_time = new Date(Number(statsigCreateResponse.data.createdTime));
                    CSV_OUTPUT_ROW.statsig_created_time = statsig_created_time.toLocaleString();
                    CSV_OUTPUT_ROW.migration_status = "SUCCESSFUL MIGRATION SCRIPT";
                    //console.log(`SUCCESS migrating the *"${flag.key}"* flag to Statsig!`);
                } else {
                    CSV_OUTPUT_ROW.migration_status = "FAILED MIGRATION SCRIPT";
                    //console.log(`FAILED migrating the *"${flag.key}"* flag to Statsig. Migration script failure.`);
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

    console.log('Migration script completed.');

    csvWriter.writeRecords(CSV_OUTPUT)
        .then(() => {
            console.log('Flag migration results written to ' + csvOutputPath);
        });

}

// Delete all flags with TAG_NAME and then migrate feature flags
// Use this to clean up a Statsig workspace after a migration attempt
deleteFeatureFlagsWithTag(TAG_NAME)
    .then(() => {
        // Call the main migration function after all flags have been deleted
        migrateFeatureFlags().catch(console.error);
    })
    .catch(console.error);
