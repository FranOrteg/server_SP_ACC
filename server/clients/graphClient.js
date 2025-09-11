const axios = require('axios');
const { getGraphToken } = require('./msalClient');

async function graphGet(url, config = {}) {
    const token = await getGraphToken();
    return axios.get(`https://graph.microsoft.com/v1.0${url}`, {
        ...config,
        headers: { Authorization: `Bearer ${token}`, ...(config.headers || {}) }
    });
}

async function graphGetStream(url) {
    const token = await getGraphToken();
    return axios.get(`https://graph.microsoft.com/v1.0${url}`, {
        responseType: 'stream',
        headers: { Authorization: `Bearer ${token}` }
    });
}

async function graphPost(url, data, config = {}) {
    const token = await getGraphToken();
    return axios.post(`https://graph.microsoft.com/v1.0${url}`, data, {
        ...config,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(config.headers || {}) }
    });
}

module.exports = {
    graphGet,
    graphGetStream,
    graphPost
};
