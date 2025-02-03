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
        baseURL: 'https://statsigapi.net',
        headers: {
            'STATSIG-API-KEY': STATSIG_API_KEY,
            'Content-Type': 'application/json',
        }
    }), {
        maxRequests: 10,
        perMilliseconds: 500
    });

export const createStatsigFeatureGate = async (featureGate) => {
    const response = await client.post('/console/v1/gates', featureGate);
    return response.data;
};

export const getTags = async () => {
    let next = `/console/v1/tags`;
    const responseData = [];
    do {
        const res = await client.get(next);
        responseData.push(...res.data.data);
        next = res.data.pagination?.nextPage;
    } while (next)
    
    return responseData;
}

export const createTag = async (tag) => {
    const createTagResponse = await client.post('/console/v1/tags', tag);

    return createTagResponse.data;
}

export const getFeatureFlagsWithTag = async (tagName) => {
    let next = `/console/v1/gates?tags=${tagName}`;
    const responseData = [];
    do {
        const res = await client.get(next);
        responseData.push(...res.data.data);
        next = res.data.pagination?.nextPage;
    } while (next)
    
    return responseData;
};

export const deleteFeatureFlag = async (flagId) => {
    return client.delete(`/console/v1/gates/${flagId}`);
};

export const addStatsigOverrides = async (overrides, gate_id) => {
    let formattedOverridePayload = {
        passingUserIDs: [],
        failingUserIDs: [],
        environmentOverrides: overrides
    }
    await client.post(`/console/v1/gates/${gate_id}/overrides`, formattedOverridePayload);
    //console.log(`Overrides for "${gate_id}" created.`);
    return true;
};