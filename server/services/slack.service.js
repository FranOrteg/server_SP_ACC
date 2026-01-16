// services/slack.service.js
//
// Servicio para gestionar canales y miembros de Slack
// durante la creación de proyectos en Skylab

const slackClient = require('../clients/slackClient');
const { mk } = require('../helpers/logger');
const log = mk('SLACK-SVC');

/**
 * Normaliza el nombre del proyecto para crear un nombre de canal válido en Slack
 * - Convierte a minúsculas
 * - Reemplaza espacios y caracteres especiales con guiones
 * - Elimina caracteres no permitidos
 * - Limita a 80 caracteres
 */
function normalizeChannelName(projectName) {
  if (!projectName) return null;
  
  let channelName = projectName
    .toLowerCase()
    .trim()
    // Reemplazar espacios y guiones bajos con guiones
    .replace(/[\s_]+/g, '-')
    // Eliminar caracteres especiales excepto guiones
    .replace(/[^a-z0-9-]/g, '')
    // Eliminar guiones múltiples
    .replace(/-+/g, '-')
    // Eliminar guiones al inicio y final
    .replace(/^-|-$/g, '');
  
  // Slack permite hasta 80 caracteres
  if (channelName.length > 80) {
    channelName = channelName.substring(0, 80);
  }
  
  return channelName;
}

/**
 * Busca usuarios de Slack por email
 * @param {string} email - Email del usuario a buscar
 * @returns {Promise<string|null>} - ID del usuario de Slack o null si no se encuentra
 */
async function findUserByEmail(email) {
  if (!email) return null;
  
  try {
    const data = await slackClient.apiGet('/users.lookupByEmail', { email });
    return data?.user?.id || null;
  } catch (e) {
    // Si no se encuentra el usuario, Slack devuelve error "users_not_found"
    if (e.slackError === 'users_not_found') {
      log.debug('Usuario no encontrado en Slack', { email });
      return null;
    }
    throw e;
  }
}

/**
 * Crea un canal de Slack
 * @param {Object} options - Opciones del canal
 * @param {string} options.name - Nombre del canal (se normalizará automáticamente)
 * @param {string} [options.description] - Descripción del canal
 * @param {boolean} [options.isPrivate=false] - Si el canal es privado
 * @returns {Promise<Object>} - Información del canal creado
 */
async function createChannel({ name, description, isPrivate = false }) {
  if (!name) {
    throw new Error('El nombre del canal es obligatorio');
  }
  
  const channelName = normalizeChannelName(name);
  
  if (!channelName) {
    throw new Error('No se pudo generar un nombre válido para el canal');
  }
  
  log.info('Creando canal de Slack', { channelName, isPrivate });
  
  try {
    const endpoint = isPrivate ? '/conversations.create' : '/conversations.create';
    const data = await slackClient.apiPost(endpoint, {
      name: channelName,
      is_private: isPrivate
    });
    
    const channelId = data?.channel?.id;
    const channelInfo = {
      id: channelId,
      name: data?.channel?.name,
      isPrivate: isPrivate,
      created: true
    };
    
    log.info('Canal de Slack creado exitosamente', channelInfo);
    
    // Si hay descripción, establecerla
    if (description && channelId) {
      try {
        await setChannelTopic(channelId, description);
        channelInfo.topic = description;
      } catch (e) {
        log.warn('No se pudo establecer la descripción del canal', { channelId, error: e.message });
      }
    }
    
    return channelInfo;
    
  } catch (e) {
    // Si el canal ya existe, intentar obtener su información
    if (e.slackError === 'name_taken') {
      log.warn('El canal ya existe, obteniendo información', { channelName });
      
      try {
        const existingChannel = await findChannelByName(channelName);
        if (existingChannel) {
          return {
            ...existingChannel,
            created: false,
            existed: true
          };
        }
      } catch (listError) {
        log.error('Error al buscar canal existente', { channelName, error: listError.message });
      }
    }
    
    throw e;
  }
}

/**
 * Busca un canal por nombre
 */
async function findChannelByName(channelName) {
  try {
    // Listar canales (puede requerir paginación para workspaces grandes)
    const data = await slackClient.apiGet('/conversations.list', {
      types: 'public_channel,private_channel',
      limit: 1000
    });
    
    const channel = data?.channels?.find(c => c.name === channelName);
    if (!channel) return null;
    
    return {
      id: channel.id,
      name: channel.name,
      isPrivate: channel.is_private
    };
  } catch (e) {
    log.error('Error al buscar canal', { channelName, error: e.message });
    return null;
  }
}

/**
 * Establece el topic/descripción del canal
 */
async function setChannelTopic(channelId, topic) {
  if (!channelId || !topic) return;
  
  await slackClient.apiPost('/conversations.setTopic', {
    channel: channelId,
    topic: topic
  });
}

/**
 * Invita usuarios a un canal de Slack
 * @param {string} channelId - ID del canal
 * @param {Array<string>} userEmails - Array de emails de usuarios
 * @returns {Promise<Object>} - Resultado de las invitaciones
 */
async function inviteUsersToChannel(channelId, userEmails = []) {
  if (!channelId || !Array.isArray(userEmails) || userEmails.length === 0) {
    return { invited: [], failed: [] };
  }
  
  log.info('Invitando usuarios al canal', { channelId, count: userEmails.length });
  
  const results = {
    invited: [],
    failed: []
  };
  
  // Buscar IDs de usuarios por email
  const userIds = [];
  for (const email of userEmails) {
    try {
      const userId = await findUserByEmail(email);
      if (userId) {
        userIds.push({ email, userId });
      } else {
        results.failed.push({ email, error: 'Usuario no encontrado en Slack' });
      }
    } catch (e) {
      results.failed.push({ email, error: e.message });
    }
  }
  
  // Invitar usuarios al canal
  for (const { email, userId } of userIds) {
    try {
      await slackClient.apiPost('/conversations.invite', {
        channel: channelId,
        users: userId
      });
      
      results.invited.push({ email, userId });
      log.debug('Usuario invitado al canal', { email, userId, channelId });
      
    } catch (e) {
      // Si el usuario ya está en el canal, no es un error crítico
      if (e.slackError === 'already_in_channel') {
        results.invited.push({ email, userId, alreadyMember: true });
        log.debug('Usuario ya era miembro del canal', { email, channelId });
      } else {
        results.failed.push({ email, error: e.message, slackError: e.slackError });
        log.warn('Error al invitar usuario al canal', { email, channelId, error: e.message });
      }
    }
  }
  
  log.info('Invitaciones completadas', {
    channelId,
    invited: results.invited.length,
    failed: results.failed.length
  });
  
  return results;
}

/**
 * Crea un canal de Slack para un proyecto e invita a los miembros
 * @param {Object} options
 * @param {string} options.projectName - Nombre del proyecto
 * @param {string} [options.projectCode] - Código del proyecto
 * @param {string} [options.description] - Descripción del canal
 * @param {Array<string>} [options.memberEmails] - Emails de los miembros a invitar
 * @param {boolean} [options.isPrivate=false] - Si el canal es privado
 * @returns {Promise<Object>} - Información del canal y resultado de invitaciones
 */
async function createProjectChannel({
  projectName,
  projectCode,
  description,
  memberEmails = [],
  isPrivate = false
}) {
  if (!slackClient.isConfigured()) {
    log.warn('Slack no está configurado, omitiendo creación de canal');
    return {
      ok: false,
      skipped: true,
      reason: 'Slack no configurado'
    };
  }
  
  // Usar solo el código del proyecto como nombre del canal
  // Si no hay código, usar el nombre del proyecto
  const fullName = projectCode || projectName;
  
  try {
    // Crear canal (sin prefijo, solo el código o nombre)
    const channel = await createChannel({
      name: fullName,
      description,
      isPrivate
    });
    
    // Invitar miembros
    let invitations = { invited: [], failed: [] };
    if (memberEmails.length > 0) {
      invitations = await inviteUsersToChannel(channel.id, memberEmails);
    }
    
    return {
      ok: true,
      channel: {
        id: channel.id,
        name: channel.name,
        isPrivate: channel.isPrivate,
        created: channel.created,
        existed: channel.existed
      },
      members: {
        invited: invitations.invited.length,
        failed: invitations.failed.length,
        details: invitations
      }
    };
    
  } catch (e) {
    log.error('Error al crear canal de proyecto en Slack', {
      projectName,
      error: e.message,
      slackError: e.slackError
    });
    
    return {
      ok: false,
      error: e.message,
      slackError: e.slackError
    };
  }
}

/**
 *  Elimina el canal de Slack por ID (opcional)
 * @param {string} channelId - ID del canal a eliminar
 */ 

async function deleteChannel(channelId) {
  if (!channelId) {
    throw new Error('El ID del canal es obligatorio para eliminarlo');
  }

  try {
    await slackClient.apiPost('/conversations.archive', {
      channel: channelId
    });
    log.info('Canal de Slack archivado exitosamente', { channelId });
  } catch (e) {
    log.error('Error al archivar el canal de Slack', { channelId, error: e.message });
    throw e;
  }
}


/**
 * Verifica si Slack está configurado correctamente
 */
function isSlackConfigured() {
  return slackClient.isConfigured();
}

module.exports = {
  createChannel,
  inviteUsersToChannel,
  createProjectChannel,
  findUserByEmail,
  normalizeChannelName,
  isSlackConfigured,
  deleteChannel
};
