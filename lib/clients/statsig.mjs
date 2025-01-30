import axios from 'axios';

const {
    STATSIG_API_KEY
} = process.env;
if (!STATSIG_API_KEY) {
    console.error('Please set the STATSIG_API_KEY environment variable.');
    process.exit(1);
}

// API endpoints
const STATSIG_API_BASE_URL = 'https://statsigapi.net/console/v1';

// Headers for Statsig API requests
const statsigHeaders = {
    headers: {
        'STATSIG-API-KEY': STATSIG_API_KEY,
        'Content-Type': 'application/json',
    },
}

export const createStatsigFeatureGate = async (featureGate) => {
    const response = await axios.post(`${STATSIG_API_BASE_URL}/gates`, featureGate, statsigHeaders);
    return response.data;
};

export const getTags = async () => {
    const tagsResponse = await axios.get(`${STATSIG_API_BASE_URL}/tags`, statsigHeaders);

    return tagsResponse.data.data;
}

export const createTag = async (tag) => {
    const createTagResponse = await axios.post(
        `${STATSIG_API_BASE_URL}/tags`,
        tag,
        statsigHeaders,
    );

    return createTagResponse.data;
}

export const getFeatureFlagsWithTag = async (tagName) => {
    const flagsResponse = await axios.get(`${STATSIG_API_BASE_URL}/gates?tags=${tagName}`, statsigHeaders);

    return flagsResponse.data.data;
};

export const deleteFeatureFlag = async (flagId) => {
    return axios.delete(`${STATSIG_API_BASE_URL}/gates/${flagId}`, statsigHeaders);
};

export const addStatsigOverrides = async (overrides, gate_id) => {
    let formattedOverridePayload = {
        passingUserIDs: [],
        failingUserIDs: [],
        environmentOverrides: overrides
    }
    await axios.post(`${STATSIG_API_BASE_URL}/gates/${gate_id}/overrides`, formattedOverridePayload, statsigHeaders);
    //console.log(`Overrides for "${gate_id}" created.`);
    return true;
};