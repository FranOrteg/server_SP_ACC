// helpers/progressEmitter.js
// Sistema de progreso en tiempo real para migraciones SP → ACC

const crypto = require('crypto');

// Registro de sesiones activas para cancelación
const activeSessions = new Map();

// Definición de pasos con pesos para el cálculo de progreso global
const STEPS = {
  reading: { weight: 15, label: 'Leyendo estructura de SharePoint' },
  processing: { weight: 10, label: 'Procesando y transformando datos' },
  uploading: { weight: 60, label: 'Subiendo archivos a ACC' },
  members: { weight: 10, label: 'Configurando miembros del proyecto' },
  finalizing: { weight: 5, label: 'Finalizando y verificando' }
};

/**
 * Calcula el progreso global basado en el paso actual y su progreso interno
 * @param {string} currentStep - Paso actual (reading, processing, uploading, members, finalizing)
 * @param {number} stepProgress - Progreso dentro del paso actual (0-100)
 * @returns {number} Progreso global (0-100)
 */
function calculateGlobalProgress(currentStep, stepProgress) {
  const steps = Object.keys(STEPS);
  const currentIndex = steps.indexOf(currentStep);
  
  if (currentIndex === -1) return 0;
  
  // Suma de pesos de pasos completados
  let completed = steps.slice(0, currentIndex).reduce((sum, s) => sum + STEPS[s].weight, 0);
  
  // Peso parcial del paso actual
  completed += (STEPS[currentStep].weight * (stepProgress || 0)) / 100;
  
  return Math.round(Math.min(completed, 100));
}

/**
 * Crea un emisor de progreso SSE
 * @param {Response} res - Objeto response de Express
 * @param {string} sessionId - ID de sesión único
 * @returns {Object} Objeto con métodos para emitir eventos
 */
function createProgressEmitter(res, sessionId) {
  let lastEmit = 0;
  const THROTTLE_MS = 100; // No emitir más de 1 evento cada 100ms
  const nonCriticalErrors = [];
  const startTime = Date.now();
  let bytesTransferred = 0;
  let filesProcessed = 0;

  // Throttle function
  const shouldEmit = () => {
    const now = Date.now();
    if (now - lastEmit >= THROTTLE_MS) {
      lastEmit = now;
      return true;
    }
    return false;
  };

  // Helper para escribir evento SSE
  const writeEvent = (eventType, data) => {
    try {
      res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      console.error('[SSE] Error writing event:', e.message);
    }
  };

  return {
    sessionId,
    startTime,
    
    /**
     * Verifica si la sesión fue cancelada EXPLÍCITAMENTE por el usuario
     * (via POST /cancel/:sessionId)
     */
    isCancelled() {
      const session = activeSessions.get(sessionId);
      return session?.cancelled === true;
    },

    /**
     * Verifica si el cliente se desconectó (cerró el navegador, perdió conexión, etc.)
     */
    isClientDisconnected() {
      const session = activeSessions.get(sessionId);
      return session?.clientDisconnected === true;
    },

    /**
     * Verifica si debemos detener el proceso (cancelación explícita O desconexión del cliente)
     */
    shouldStop() {
      const session = activeSessions.get(sessionId);
      if (!session) return false;
      return session.cancelled === true || session.clientDisconnected === true;
    },

    /**
     * Lanza error si fue cancelada EXPLÍCITAMENTE por el usuario
     * NO lanza error por desconexión del cliente (el proceso puede continuar)
     */
    checkCancellation() {
      if (this.isCancelled()) {
        throw new Error('CANCELLED');
      }
      // Opcionalmente, también puedes detener si el cliente se desconectó
      // Descomenta si quieres que la desconexión también detenga el proceso:
      // if (this.isClientDisconnected()) {
      //   throw new Error('CLIENT_DISCONNECTED');
      // }
    },

    /**
     * Emite un evento de progreso
     */
    progress(data) {
      if (!shouldEmit() && !data.force) return;
      
      const payload = {
        sessionId,
        status: 'running',
        progress: calculateGlobalProgress(data.currentStep, data.stepProgress),
        currentStep: data.currentStep,
        stepProgress: data.stepProgress || 0,
        stepLabel: STEPS[data.currentStep]?.label || data.currentStep,
        message: data.message || '',
        details: {
          totalItems: data.totalItems || 0,
          processedItems: data.processedItems || 0,
          currentItem: data.currentItem || '',
          bytesTransferred: data.bytesTransferred || bytesTransferred,
          bytesTotal: data.bytesTotal || 0,
          errors: nonCriticalErrors.slice(-10) // Últimos 10 errores no críticos
        }
      };
      
      writeEvent('progress', payload);
    },

    /**
     * Emite evento de finalización exitosa
     */
    complete(result, summary = {}) {
      filesProcessed = summary.filesProcessed || filesProcessed;
      bytesTransferred = summary.bytesTransferred || bytesTransferred;
      
      const payload = {
        sessionId,
        status: 'completed',
        progress: 100,
        result,
        summary: {
          duration: Date.now() - startTime,
          filesProcessed,
          bytesTransferred,
          membersAdded: summary.membersAdded || 0,
          errors: nonCriticalErrors
        }
      };
      
      writeEvent('complete', payload);
    },

    /**
     * Emite evento de error fatal
     */
    error(error, partialResult = null, failedAt = null) {
      const payload = {
        sessionId,
        status: 'error',
        error: error?.message || String(error),
        failedAt: failedAt || 'unknown',
        canRetry: true,
        partialResult,
        summary: {
          duration: Date.now() - startTime,
          filesProcessed,
          bytesTransferred,
          errors: nonCriticalErrors
        }
      };
      
      writeEvent('error', payload);
    },

    /**
     * Emite evento de cancelación
     */
    cancelled(partialResult = null) {
      const payload = {
        sessionId,
        status: 'cancelled',
        message: 'Operación cancelada por el usuario',
        partialResult,
        summary: {
          duration: Date.now() - startTime,
          filesProcessed,
          bytesTransferred
        }
      };
      
      writeEvent('cancelled', payload);
    },

    /**
     * Registra un error no crítico (para reportar al final)
     */
    addNonCriticalError(error) {
      nonCriticalErrors.push({
        timestamp: new Date().toISOString(),
        message: error?.message || String(error)
      });
    },

    /**
     * Actualiza contadores internos
     */
    updateStats({ bytes, files }) {
      if (bytes) bytesTransferred += bytes;
      if (files) filesProcessed += files;
    },

    /**
     * Obtiene estadísticas actuales
     */
    getStats() {
      return { bytesTransferred, filesProcessed, duration: Date.now() - startTime };
    }
  };
}

/**
 * Configura los headers SSE y registra la sesión
 */
function setupSSE(req, res) {
  const sessionId = crypto.randomUUID();
  
  // Headers SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Para nginx
  res.setHeader('X-Session-Id', sessionId);
  res.flushHeaders();

  // Registrar sesión activa
  // IMPORTANTE: cancelled se usa SOLO para cancelación explícita del usuario via /cancel endpoint
  // NO se marca como cancelled cuando el cliente cierra la conexión (eso es clientDisconnected)
  activeSessions.set(sessionId, { 
    req, 
    res, 
    cancelled: false,           // Cancelación explícita del usuario
    clientDisconnected: false,  // Cliente cerró la conexión
    completed: false,           // El proceso ha terminado (success o error)
    startedAt: Date.now() 
  });

  console.log('[SSE] Sesión creada:', sessionId, '| Total sesiones activas:', activeSessions.size);

  // Manejar desconexión del cliente
  // NOTA: En SSE con POST, el evento 'close' puede dispararse cuando termina el body
  // pero la conexión SSE sigue abierta. Solo marcamos como desconectado si el socket
  // realmente está destruido o la respuesta ya terminó.
  req.on('close', () => {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    // Verificar si realmente se cerró la conexión o es un falso positivo
    const socketDestroyed = req.socket?.destroyed === true;
    const responseEnded = res.writableEnded === true;
    const clientAborted = req.aborted === true;
    
    console.log('[SSE DEBUG] req.close event', {
      sessionId,
      socketDestroyed,
      responseEnded,
      clientAborted,
      alreadyCancelled: session.cancelled,
      completed: session.completed
    });

    // Solo marcar como desconectado si hay evidencia real de desconexión
    // Y no hemos terminado nosotros la respuesta (res.end())
    if ((socketDestroyed || clientAborted) && !responseEnded) {
      session.clientDisconnected = true;
      console.log('[SSE] Cliente realmente desconectado:', sessionId);
    }
    
    // NO eliminar la sesión aquí - se elimina cuando el proceso termina
    // o después de un tiempo largo (5 minutos) para permitir cancelación
    // La sesión se elimina en res.on('finish') cuando el proceso completa
    if (!session.completed) {
      // El proceso aún está corriendo, programar limpieza para más tarde
      // 5 minutos es suficiente para que el usuario pueda cancelar
      setTimeout(() => {
        const s = activeSessions.get(sessionId);
        if (s && !s.completed) {
          console.log('[SSE] Limpieza de sesión huérfana:', sessionId);
          activeSessions.delete(sessionId);
        }
      }, 5 * 60 * 1000); // 5 minutos
    }
  });

  // Keep-alive ping cada 30 segundos
  const keepAlive = setInterval(() => {
    if (!activeSessions.has(sessionId)) {
      clearInterval(keepAlive);
      return;
    }
    try {
      res.write(`:ping\n\n`);
    } catch {
      clearInterval(keepAlive);
    }
  }, 30000);

  // Limpiar interval cuando termine
  res.on('finish', () => {
    clearInterval(keepAlive);
    const session = activeSessions.get(sessionId);
    if (session) {
      session.completed = true;
      console.log('[SSE] Sesión completada, programando limpieza:', sessionId);
      // Dar un pequeño margen antes de eliminar por si hay peticiones de info pendientes
      setTimeout(() => activeSessions.delete(sessionId), 10000); // 10 segundos
    }
  });

  return { sessionId, emitter: createProgressEmitter(res, sessionId) };
}

/**
 * Cancela una sesión activa
 */
function cancelSession(sessionId) {
  console.log('[CANCEL] Buscando sesión en activeSessions:', sessionId);
  console.log('[CANCEL] Sesiones disponibles:', [...activeSessions.keys()]);
  
  const session = activeSessions.get(sessionId);
  if (session) {
    console.log('[CANCEL] Sesión encontrada, marcando como cancelled');
    session.cancelled = true;
    return { ok: true, message: 'Cancelación solicitada' };
  }
  
  console.log('[CANCEL] Sesión NO encontrada');
  return { ok: false, message: 'Sesión no encontrada' };
}

/**
 * Obtiene información de una sesión
 */
function getSessionInfo(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return null;
  return {
    sessionId,
    cancelled: session.cancelled,
    clientDisconnected: session.clientDisconnected,
    startedAt: session.startedAt,
    runningFor: Date.now() - session.startedAt
  };
}

/**
 * Lista todas las sesiones activas
 */
function listActiveSessions() {
  const sessions = [];
  activeSessions.forEach((session, id) => {
    sessions.push({
      sessionId: id,
      cancelled: session.cancelled,
      clientDisconnected: session.clientDisconnected,
      startedAt: session.startedAt,
      runningFor: Date.now() - session.startedAt
    });
  });
  return sessions;
}

module.exports = {
  STEPS,
  calculateGlobalProgress,
  createProgressEmitter,
  setupSSE,
  cancelSession,
  getSessionInfo,
  listActiveSessions,
  activeSessions
};
