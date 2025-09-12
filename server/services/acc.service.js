// services/acc.service.js
const aps = require('../clients/apsClient');

// Hubs del usuario (ACC/BIM 360)
async function listHubs() {
  return await aps.apiGet('/project/v1/hubs');
}

// Proyectos dentro de un hub
async function listProjects(hubId) {
  return await aps.apiGet(`/project/v1/hubs/${hubId}/projects`);
}

// Carpetas raíz de un proyecto
async function listTopFolders(projectId) {
  return await aps.apiGet(`/data/v1/projects/${encodeURIComponent(projectId)}/topFolders`);
}

module.exports = { 
    listHubs, 
    listProjects, 
    listTopFolders
};
