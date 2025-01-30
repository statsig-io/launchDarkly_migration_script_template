import * as launchDarkly from '../clients/launchdarkly.mjs';

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

// Since all flags are being loaded into the same Statsig project, we need to ensure that all flag keys are unique.
function ensureUniqueFlagKeys(flags) {
  const duplicateKeys = Object.values(
    Object.groupBy(flags.map(f => f.key), key => key)
  )
    .filter(keys => keys.length > 1)
    .map(keys => keys[0]);

  flags
    .filter(flag => duplicateKeys.includes(flag.key))
    .forEach(flag => {
      flag.key = `${flag.project}.${flag.key}`;
    });
}

/**
 * Extracts LaunchDarkly flags from the given projects.
 * Returns an object that contains the detected environments and the flags.
 * @param {string[]} ldProjects 
 * @returns {Promise<{detectedEnvironments: string[], ldFlags: any[]}>}
 */
export async function extractLaunchDarklyFlags(ldProjects) {
  const ldFlags = (await Promise.all(
    ldProjects.map(async (ldProject) => {
      const items = await launchDarkly.getFeatureFlags(ldProject);
      console.log(`Fetched LaunchDarkly flags successfully for project ${ldProject}.`);
      return items.map(item => ({
        ...item,
        tags: [
          // adding in a new tag to help track which project the flag came from
          `ld-project:${ldProject}`,
          ...item.tags
        ],
        // adding in a project key to help ensure uniqueness across all of the feature flags
        project: ldProject
      }));
    })
  )).flat();
  
  ensureUniqueFlagKeys(ldFlags);
  const detectedEnvironments = getUniqueEnvironmentKeys(ldFlags);

  return {
    ldProjects,
    detectedEnvironments,
    ldFlags,
  };
}