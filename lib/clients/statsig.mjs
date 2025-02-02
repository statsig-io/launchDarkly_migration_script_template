import axios from 'axios';
import rateLimit from 'axios-rate-limit';

const {
    STATSIG_API_KEY
} = process.env;
if (!STATSIG_API_KEY) {
    console.error('Please set the STATSIG_API_KEY environment variable.');
    process.exit(1);
}

const client = rateLimit(
    axios.create({
        baseURL: 'https://statsigapi.net/console/v1',
        headers: {
            'STATSIG-API-KEY': STATSIG_API_KEY,
            'Content-Type': 'application/json',
        }
    }), {
        maxRequests: 10,
        perMilliseconds: 500
    });

export const createStatsigFeatureGate = async (featureGate) => {
    const response = await client.post('/gates', featureGate);
    return response.data;
};

export const getTags = async () => {
    const tagsResponse = await client.get('/tags');

    return tagsResponse.data.data;
}

export const createTag = async (tag) => {
    const createTagResponse = await client.post('/tags', tag);

    return createTagResponse.data;
}

export const getFeatureFlagsWithTag = async (tagName) => {
    const flagsResponse = await client.get(`/gates?tags=${tagName}`);

    return flagsResponse.data.data;
};

export const deleteFeatureFlag = async (flagId) => {
    return client.delete(`/gates/${flagId}`);
};

export const addStatsigOverrides = async (overrides, gate_id) => {
    let formattedOverridePayload = {
        passingUserIDs: [],
        failingUserIDs: [],
        environmentOverrides: overrides
    }
    await client.post(`/gates/${gate_id}/overrides`, formattedOverridePayload);
    //console.log(`Overrides for "${gate_id}" created.`);
    return true;
};