// services/admin.users.service.js

const { graphGet } = require('../clients/graphClient');

/**
 * Busca usuarios del tenant para autocompletar.
 * Requiere Graph Directory.Read.All (app) o User.ReadBasic.All (delegado) + header ConsistencyLevel:eventual.
 *
 * @param {Object} opts
 * @param {string} opts.q           - texto a buscar
 * @param {number} [opts.top=20]    - tamaño de página (1..50)
 * @param {string} [opts.next]      - $skiptoken devuelto por la llamada anterior
 * @param {boolean} [opts.onlyEnabled=true] - filtra accountEnabled eq true
 * @param {boolean} [opts.includeGuests=false] - incluir invitados (userType eq 'Guest')
 */
async function searchTenantUsers({ q = '', top = 20, next, onlyEnabled = true, includeGuests = false } = {}) {
  // Usamos $search (mejor ranking, busca en displayName/mail/userPrincipalName)
  // IMPORTANTE: requiere ConsistencyLevel: eventual y $count=true
  // Ejemplo: /users?$search="displayName:ana OR mail:ana OR userPrincipalName:ana"
  const terms = (q || '').trim();
  const searchExpr = terms
    ? `"displayName:${terms} OR mail:${terms} OR userPrincipalName:${terms}"`
    : '"*"';

  const params = new URLSearchParams();
  params.set('$search', searchExpr);
  params.set('$count', 'true');
  params.set('$select', 'id,displayName,mail,userPrincipalName,userType,accountEnabled');
  params.set('$top', String(Math.max(1, Math.min(top, 50))));
  if (next) params.set('$skiptoken', next);

  // Filtro opcional (accountEnabled / guests)
  const filters = [];
  if (onlyEnabled) filters.push('accountEnabled eq true');
  if (!includeGuests) filters.push("userType ne 'Guest'");
  if (filters.length) params.set('$filter', filters.join(' and '));

  const { data } = await graphGet(`/users?${params.toString()}`, {
    headers: { ConsistencyLevel: 'eventual' }
  });

  const items = (data?.value || []).map(u => ({
    id: u.id,
    displayName: u.displayName,
    mail: u.mail,
    userPrincipalName: u.userPrincipalName,
    userType: u.userType,
    accountEnabled: u.accountEnabled
  }));

  // nextLink → extraer $skiptoken si existe
  let nextToken = null;
  const nl = data?.['@odata.nextLink'];
  if (nl) {
    const url = new URL(nl);
    nextToken = url.searchParams.get('$skiptoken');
  }

  return {
    count: data?.['@odata.count'] ?? items.length,
    items,
    next: nextToken
  };
}

module.exports = { searchTenantUsers };
