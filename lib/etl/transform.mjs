import { TAG_NAME } from '../constants.mjs';

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

/**
 * Use this map to translate LaunchDarkly project environments to Statsig environments.
 * 
 * Sometimes there may be an environment in LaunchDarly that is named one thing,
 * but the key of the environment does not align with the expected name in StatSig.
 * 
 * i.e.:
 * const statsigEnvironmentMap = {
 *   // for the project 'super-cool-site', map the 'test' environment in LaunchDarkly to the 'qa' environment in Statsig
 *   'super-cool-site': {
 *     'test': 'qa'
 *    }
 * };
 */
const statsigEnvironmentMap = {};

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
// Escapes special characters in a string to be used in a regex.
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
            return values.map(value =>
                (typeof value != "string" && typeof value != "number")
                    ? JSON.stringify(value)
                    : value
            );
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
    rule.clauses.map(clause => conditions.push(translateLaunchDarklyClause(clause)));

    var ruleName = '(' + environmentName + ') ' + (rule.description ? rule.description + ' import' + ruleIndex : 'import' + ruleIndex);

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
    if (flag.kind !== 'boolean')
        return false;
    // Translate variations and targeting rules from LaunchDarkly to Statsig format
    const isFlagTemporary = flag.temporary ? 'PERMANENT' : 'TEMPORARY';

    let statsigFeatureFlagOverrides = [];

    // Prepare a common structure for both feature flags and dynamic configs
    const statsigFeatureFlag = {
        name: flag.key,
        description: flag.description,
        type: isFlagTemporary,
        //If atleast one environment is on, enable the feature flag in Statsig
        isEnabled: Object.values(flag.environments || {}).some(env => env.on),
        rules: [],
        tags: [
            TAG_NAME,
            ...flag.tags
        ]
    };

    // For each environment in LaunchDarkly, create a corresponding overrides and rules in Statsig
    Object
        .entries(flag.environments || {})
        .forEach(([ldEnvName, environmentData]) => {
            // Map the launch darkly environment key to statsig environment key
            const statsigEnvironment = statsigEnvironmentMap[flag.project]?.[ldEnvName] || ldEnvName;

            //If there are overrides manage them
            if (environmentData.targets.length > 0) {
                // Start building override object to send to statsig
                let environmentOverride = {
                    environment: statsigEnvironment,
                    unitID: 'userID',
                    passingIDs: [],
                    failingIDs: []
                };

                // Build the override object
                environmentData.targets.forEach(overrideTarget => {
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
            statsigFeatureFlag.rules = environmentData.rules.map(
                (ldRule, ruleIndex) => translateLaunchDarklyRule(ldRule, statsigEnvironment, environmentData, ruleIndex)
            );

            //manage the fall through rules
            const statsigFallthroughRule = translateLaunchDarklyFallthroughRule(statsigEnvironment, environmentData);
            statsigFeatureFlag.rules.push(statsigFallthroughRule);
        });

    const arrProduction = statsigFeatureFlag.rules.filter(rule => rule.environments.indexOf("production") != -1);
    const arrNonProduction = statsigFeatureFlag.rules.filter(rule => rule.environments.indexOf("production") == -1);
    statsigFeatureFlag.rules = [...arrProduction, ...arrNonProduction];

    return { statsigFeatureFlag, statsigFeatureFlagOverrides };
}

function translateLaunchDarklyFallthroughRule(environmentName, environmentFlag) {   

    var ruleName = '(' + environmentName + ') Fall through imported rule';

    const fallthroughRule = {
        name: ruleName,
        passPercentage: 0,
        conditions: [{ "type": "public" }],
        environments: [environmentName]
    };

    if (!environmentFlag.on) {
        fallthroughRule.passPercentage = environmentFlag.offVariation == 0 ? 100 : 0;
    } else if (environmentFlag.fallthrough.rollout) {
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

/**
 * Transforms LaunchDarkly flags to Statsig flags
 * @param {{ ldFlags: any[] }} extractionResults 
 * @returns {{transformResults: {statsigFeatureFlag: any, statsigFeatureFlagOverrides: any, ldFlag: any}[]}}
 */
export function transformLaunchDarklyFlagsToStatSigFlags({ ldFlags, ...passthrough }) {
    return {
        ...passthrough,
        ldFlags,
        transformResults: ldFlags.map(ldFlag => {
            const { statsigFeatureFlag, statsigFeatureFlagOverrides } = translateLDFlagToStatsig(ldFlag);
            return {
                statsigFeatureFlag,
                statsigFeatureFlagOverrides,
                ldFlag
            }
        })
    };
}