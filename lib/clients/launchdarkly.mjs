import axios from 'axios';

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

const LD_API_BASE_URL = 'https://app.launchdarkly.com';
const ldHeaders = {
    headers: {
        Authorization: LAUNCHDARKLY_API_KEY
    }
};

export async function getFeatureFlags(ldProject) {
    if (flagsFromLdApiCallResponse) {
        return flagsFromLdApiCallResponse;
    }

    try {
        const response = await axios.get(`${LD_API_BASE_URL}/api/v2/flags/${ldProject}?summary=0}`, ldHeaders);
        return response.data.items;
    } catch (error) {
        console.error('Error fetching flags from LaunchDarkly:', error);
        throw new Error('Failed to fetch flags from LaunchDarkly.');
    }
};