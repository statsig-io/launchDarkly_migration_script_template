import axios from 'axios';
import rateLimit from 'axios-rate-limit';

const {
    LAUNCHDARKLY_API_KEY
} = process.env;

if (!LAUNCHDARKLY_API_KEY) {
    console.error('Please set the LAUNCHDARKLY_API_KEY environment variable.');
    process.exit(1);
}

// Set this to a cached response from a previous call to the LaunchDarkly API
const flagsFromLdApiCallResponse = undefined;
// See code block below on vars to supply
/* 
Plug in a cached response to GET "/api/v2/flags/${LAUNCHDARKLY_PROJECT_KEY}?summary=0" into flagsFromLdApiCallResponse
These would be only the items in the response from LaunchDarkly
For example it should be structured like this:

const flagsFromLdApiCallResponse = [...];
*/

const client = rateLimit(
    axios.create({
        baseURL: 'https://app.launchdarkly.com',
        headers: {
            Authorization: LAUNCHDARKLY_API_KEY
        }
    }),
    {
        maxRequests: 10,
        perMilliseconds: 500
    });

export async function getFeatureFlag(ldProject, flagKey) {
    try {
        const response = await client.get(`/api/v2/flags/${ldProject}/${flagKey}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching flag ${flagKey} from LaunchDarkly:`, error);
        throw new Error(`Failed to fetch flag ${flagKey} from LaunchDarkly.`, { cause: error });
    }
}

export async function getFeatureFlags(ldProject) {
    if (flagsFromLdApiCallResponse) {
        return flagsFromLdApiCallResponse;
    }

    const allFlags = [];
    let nextPage = `/api/v2/flags/${ldProject}?summary=0`;
    do {
        try {
            const response = await client.get(nextPage);
            allFlags.push(...response.data.items);
            nextPage = response.data._links?.next?.href;
        } catch (error) {
            console.error('Error fetching flags from LaunchDarkly:', error);
            throw new Error('Failed to fetch flags from LaunchDarkly.', { cause: error});
        }
    } while (nextPage);

    return allFlags;
};