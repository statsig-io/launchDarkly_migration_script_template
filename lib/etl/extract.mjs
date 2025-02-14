import * as launchDarkly from '../clients/launchdarkly.mjs';

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

function hydrateFlag(flag, ldProject) { 
  return {
    ...flag,
    tags: [
      // adding in a new tag to help track which project the flag came from
      `ld-project:${ldProject}`,
      ...flag.tags
    ],
    // adding in a project key to help ensure uniqueness across all of the feature flags
    project: ldProject
  };
}

/**
 * Extracts LaunchDarkly flags from the given projects.
 * Returns an object that contains the detected environments and the flags.
 * @param {string[]} ldProjects 
 * @returns {Promise<{ldFlags: any[]}>}
 */
export async function extractLaunchDarklyFlags(ldProjects) {
  // fetch all of the feature flags from the projects.
  // This will not return the environment specifics for each flag.
  const projectFlags = (await Promise.all(
    ldProjects.map(async (ldProject) => {
      const items = await launchDarkly.getFeatureFlags(ldProject);
      console.log(`Fetched ${items.length} LaunchDarkly flags successfully for project ${ldProject}.`);
      return items.map(item => hydrateFlag(item, ldProject));
    })
  )).flat();

  // fetch each flag individually to get the environment specifics
  const ldFlags = await Promise.all(
    projectFlags.map(async (flag) => {
      const ldFlag = await launchDarkly.getFeatureFlag(flag.project, flag.key);
      return hydrateFlag(ldFlag, flag.project);
    })
  );
  
  ensureUniqueFlagKeys(ldFlags);
  
  return {
    ldProjects,
    ldFlags,
  };
}