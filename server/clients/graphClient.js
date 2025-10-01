// clients/graphClient.js

const axios = require('axios');
const { getGraphToken } = require('./msalClient');

// Configuración de reintentos
const DEFAULT_TIMEOUT = 30000; // 30s
const DEFAULT_MAX_RETRIES = 3;

/**
 * Helper para reintentar requests con backoff exponencial
 */
async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.baseDelay ?? 1000;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status;
      const isLastAttempt = attempt === maxRetries;
      
      // Determinar si es reintentable
      const isRetryable = 
        !status || // errores de red/timeout
        status === 429 || // rate limit
        status >= 500; // errores de servidor
      
      if (!isRetryable || isLastAttempt) {
        throw err;
      }

      // Calcular delay con backoff exponencial + jitter
      const retryAfter = err?.response?.headers?.['retry-after'];
      const delay = retryAfter 
        ? parseInt(retryAfter) * 1000
        : Math.min(
            30000, // max 30s
            baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000
          );

      console.warn(
        `[Graph] Reintentando (${attempt}/${maxRetries}) después de ${delay}ms - ` +
        `Status: ${status || 'network error'}`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function graphGet(url, config = {}) {
  return withRetry(async () => {
    const token = await getGraphToken();
    return axios.get(`https://graph.microsoft.com/v1.0${url}`, {
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      ...config,
      headers: { 
        Authorization: `Bearer ${token}`, 
        ...(config.headers || {}) 
      }
    });
  }, {
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelay: config.baseDelay ?? 1000
  });
}

async function graphGetStream(url, config = {}) {
  // Los streams no reintentan automáticamente
  const token = await getGraphToken();
  return axios.get(`https://graph.microsoft.com/v1.0${url}`, {
    responseType: 'stream',
    timeout: config.timeout ?? 60000, // 60s para streams
    maxRedirects: 5, // permitir redirects (para /content)
    headers: { 
      Authorization: `Bearer ${token}`,
      ...(config.headers || {})
    }
  });
}

async function graphPost(url, data, config = {}) {
  return withRetry(async () => {
    const token = await getGraphToken();
    return axios.post(`https://graph.microsoft.com/v1.0${url}`, data, {
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      ...config,
      headers: { 
        Authorization: `Bearer ${token}`, 
        'Content-Type': 'application/json', 
        ...(config.headers || {}) 
      }
    });
  }, {
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelay: config.baseDelay ?? 1000
  });
}

async function graphPatch(url, data, config = {}) {
  return withRetry(async () => {
    const token = await getGraphToken();
    return axios.patch(`https://graph.microsoft.com/v1.0${url}`, data, {
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      ...config,
      headers: { 
        Authorization: `Bearer ${token}`, 
        'Content-Type': 'application/json', 
        ...(config.headers || {}) 
      }
    });
  }, {
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelay: config.baseDelay ?? 1000
  });
}

async function graphDelete(url, config = {}) {
  return withRetry(async () => {
    const token = await getGraphToken();
    return axios.delete(`https://graph.microsoft.com/v1.0${url}`, {
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      ...config,
      headers: { 
        Authorization: `Bearer ${token}`, 
        ...(config.headers || {}) 
      }
    });
  }, {
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelay: config.baseDelay ?? 1000
  });
}

module.exports = {
  graphGet,
  graphGetStream,
  graphPost,
  graphPatch,
  graphDelete
};