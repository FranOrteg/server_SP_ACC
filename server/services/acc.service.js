const { getThreeLeggedClient, ForgeSDK } = require('../clients/apsClient');

/**
 * Nota: Necesitamos el access_token del usuario (3-legged) que guardaremos al loguearse.
 * Aquí asumimos que nos llega `credentials` con access_token válido (y refresh si hace falta).
 */

async function listHubs(credentials) {
  const hubsApi = new ForgeSDK.HubsApi();
  const { body } = await hubsApi.getHubs({}, null, credentials);
  return body.data || [];
}

async function listProjects(credentials, hubId) {
  const projectsApi = new ForgeSDK.ProjectsApi();
  const { body } = await projectsApi.getHubProjects(hubId, {}, null, credentials);
  return body.data || [];
}

async function listFolderContents(credentials, projectId, folderId) {
  const foldersApi = new ForgeSDK.FoldersApi();
  const { body } = await foldersApi.getFolderContents(projectId, folderId, {}, null, credentials);
  return body.data || [];
}

module.exports = {
  getThreeLeggedClient,
  listHubs,
  listProjects,
  listFolderContents
};
