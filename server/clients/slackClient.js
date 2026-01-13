// clients/slackClient.js
//
// Cliente para interactuar con la API de Slack
// Requiere: SLACK_BOT_TOKEN en las variables de entorno

const axios = require('axios');
const { mk } = require('../helpers/logger');
const log = mk('SLACK');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_API_BASE = 'https://slack.com/api';

/**
 * Cliente HTTP para Slack API
 */
const slackClient = axios.create({
  baseURL: SLACK_API_BASE,
  headers: {
    'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

/**
 * Interceptor para logging
 */
slackClient.interceptors.response.use(
  (response) => {
    // Slack devuelve 200 pero puede indicar error en response.data.ok
    if (!response.data?.ok) {
      log.warn('Slack API warning', { 
        url: response.config.url, 
        error: response.data?.error 
      });
    }
    return response;
  },
  (error) => {
    log.error('Slack API error', { 
      url: error.config?.url, 
      status: error.response?.status,
      message: error.message 
    });
    return Promise.reject(error);
  }
);

/**
 * Verifica si el token de Slack está configurado
 */
function isConfigured() {
  return !!SLACK_BOT_TOKEN;
}

/**
 * Realiza un POST a la API de Slack
 */
async function apiPost(endpoint, body = {}) {
  if (!isConfigured()) {
    throw new Error('SLACK_BOT_TOKEN no configurado');
  }
  
  const response = await slackClient.post(endpoint, body);
  
  if (!response.data?.ok) {
    const error = new Error(response.data?.error || 'Slack API error');
    error.slackError = response.data?.error;
    error.response = response;
    throw error;
  }
  
  return response.data;
}

/**
 * Realiza un GET a la API de Slack
 */
async function apiGet(endpoint, params = {}) {
  if (!isConfigured()) {
    throw new Error('SLACK_BOT_TOKEN no configurado');
  }
  
  const response = await slackClient.get(endpoint, { params });
  
  if (!response.data?.ok) {
    const error = new Error(response.data?.error || 'Slack API error');
    error.slackError = response.data?.error;
    error.response = response;
    throw error;
  }
  
  return response.data;
}

module.exports = {
  apiPost,
  apiGet,
  isConfigured
};
