import * as statSig from '../clients/statsig.mjs';
import { TAG_NAME } from '../constants.mjs';

async function checkAndCreateTag(tagName) {
    try {
        // Step 1: Fetch existing tags to check if the tag already exist
        const tags = await statSig.getTags()
        const tagExists = tags.some(tag => tag.name === tagName);

        // Step 2: If the tag doesn't exist, create it
        if (!tagExists) {
            const createdTag = await statSig.createTag({
                name: tagName,
                description: "Tags migrated from the LD to Statsig migration script"
            });

            console.log(`Tag "${tagName}" created successfully.`);
            return createdTag;
        } else {
            //console.log(`Tag "${tagName}" already exists.`);
            return null;
        }
    } catch (error) {
        //console.error('Error checking or creating tag:', error);
        if (error.response?.data?.errors) {
            console.log(`Error creating Tag "${tagName}".`);
            console.log(error.response.data.errors);
        }
        throw error;
    }
}

// Prepare Statsig by ensuring the tag exists and cleaning up any existing flags with the tag
export async function prepareStatsig() {
    // Ensure that the tag exists in Statsig
    await checkAndCreateTag(TAG_NAME);

    // Clean up any existing flags with the tag
    const flagsToDelete = await statSig.getFeatureFlagsWithTag(TAG_NAME);
    console.log(`Found ${flagsToDelete.length} feature gates tagged with "${TAG_NAME}"`);

    await Promise.all(flagsToDelete.map(flag => statSig.deleteFeatureFlag(flag.id)));
    console.log('SUCCESS All Statsig feature flags tagged "' + TAG_NAME + '" have been cleaned up.');
}

/**
 * Ensures all tags are created in Statsig and loads the flags into Statsig
 * @param {{statsigFeatureFlag: any, statsigFeatureFlagOverrides: any, ldFlag: any }[]} transformResults 
 * @returns {Promise<{ loadResults: {ldFlag: any, statsigFeatureFlag: any, error: Error}[] }>}
 */
export async function loadFlagsIntoStatSig({ transformResults, ...passthrough }) {
    // Ensure that we have all of the deisred tags loadded into Statsig
    const allTags = transformResults
        .filter(({ statsigFeatureFlag }) => !!statsigFeatureFlag)
        .map(({ statsigFeatureFlag }) => statsigFeatureFlag.tags).flat();
    const uniqueTags = [...new Set(allTags)];
    await Promise.all(uniqueTags.map(checkAndCreateTag));

    // load the flags into Statsig
    return {
        ...passthrough,
        transformResults,
        loadResults: await Promise.all(transformResults.map(async ({ statsigFeatureFlag, statsigFeatureFlagOverrides, ldFlag }) => {
            try {
                if (!statsigFeatureFlag) {
                    return {
                        ldFlag,
                        statsigFeatureFlag: null,
                        error: new Error('NEEDS MANUAL MIGRATION FOR NON BOOLEAN FLAGS'),
                    }
                }
    
                const statsigCreateResponse = await statSig.createStatsigFeatureGate(statsigFeatureFlag);
                if (statsigFeatureFlagOverrides.length > 0) {
                    await statSig.addStatsigOverrides(statsigFeatureFlagOverrides, statsigCreateResponse.data.id);
                }
                return {
                    ldFlag,
                    statsigFeatureFlag: statsigCreateResponse.data,
                    error: null,
                };
            } catch (error) {
                console.error('Error loading flag into Statsig:', error?.response?.data?.errors || error);
                return {
                    ldFlag,
                    statsigFeatureFlag: null,
                    error: new Error("FAILED MIGRATION SCRIPT", { cause: error })
                };
            } finally {
                console.log(`Processed ${ldFlag.key} flag.`);
            }
        })),
    };
}