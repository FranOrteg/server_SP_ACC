# 📦 Contrato de Endpoints - Sistema de Archivado de Sitios (Soft Delete)

## 🎯 Resumen Ejecutivo

Sistema completo de **soft delete** para sitios de SharePoint. Los sitios archivados se ocultan de las listas activas pero permanecen intactos en SharePoint, permitiendo restauración sin pérdida de datos.

---

## 📡 Endpoints Implementados

### 1. Archivar Sitio

**Endpoint:** `POST /api/admin/sp/sites/archive`

**Request Body:**
```json
{
  "siteId": "abc123-def456-789",
  "siteUrl": "https://tenant.sharepoint.com/sites/proyecto1",
  "siteName": "Proyecto Demo",
  "hubId": "hub-id-opcional",
  "metadata": {
    "reason": "Proyecto finalizado",
    "customField": "valor"
  }
}
```

**Campos:**
| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `siteId` | string | ✅ | ID del sitio de SharePoint |
| `siteUrl` | string | ✅ | URL completa del sitio |
| `siteName` | string | ⚠️ | Nombre descriptivo (opcional) |
| `hubId` | string | ⚠️ | ID del hub asociado (opcional) |
| `metadata` | object | ⚠️ | Metadata adicional en JSON (opcional) |

**Respuesta Exitosa (200):**
```json
{
  "ok": true,
  "archived": {
    "siteId": "abc123-def456-789",
    "siteUrl": "https://tenant.sharepoint.com/sites/proyecto1",
    "siteName": "Proyecto Demo",
    "archivedAt": "2026-01-22T10:30:00.000Z",
    "archivedBy": "user@company.com"
  },
  "message": "Sitio archivado correctamente"
}
```

**Errores:**
- `400` - Falta siteId o siteUrl
- `409` - Sitio ya está archivado
- `500` - Error de base de datos

---

### 2. Restaurar Sitio

**Endpoint:** `POST /api/admin/sp/sites/restore`

**Request Body:**
```json
{
  "siteId": "abc123-def456-789"
}
```

**Respuesta Exitosa (200):**
```json
{
  "ok": true,
  "restored": {
    "siteId": "abc123-def456-789",
    "siteUrl": "https://tenant.sharepoint.com/sites/proyecto1",
    "siteName": "Proyecto Demo",
    "restoredAt": "2026-01-22T11:00:00.000Z",
    "restoredBy": "user@company.com"
  },
  "message": "Sitio restaurado correctamente"
}
```

**Errores:**
- `400` - Falta siteId
- `404` - Sitio no encontrado en archivados
- `500` - Error de base de datos

---

### 3. Listar Sitios Archivados

**Endpoint:** `GET /api/admin/sp/sites/archived`

**Query Parameters:**
| Parámetro | Tipo | Default | Descripción |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Máximo de resultados |
| `offset` | number | 0 | Offset para paginación |
| `hubId` | string | null | Filtrar por hub específico |

**Ejemplo:**
```
GET /api/admin/sp/sites/archived?limit=25&offset=0&hubId=hub123
```

**Respuesta (200):**
```json
{
  "items": [
    {
      "id": 1,
      "siteId": "abc123",
      "siteUrl": "https://tenant.sharepoint.com/sites/proyecto1",
      "siteName": "Proyecto Demo",
      "archivedAt": "2026-01-15T10:00:00.000Z",
      "archivedBy": "admin@company.com",
      "hubId": "hub123",
      "status": "archived"
    }
  ],
  "total": 15,
  "limit": 25,
  "offset": 0
}
```

---

### 4. Verificar Estado de Archivado

**Endpoint:** `GET /api/admin/sp/sites/check-archived`

**Query Parameters:**
| Parámetro | Tipo | Obligatorio | Descripción |
|-----------|------|-------------|-------------|
| `siteId` | string | ✅ | ID del sitio a verificar |

**Ejemplo:**
```
GET /api/admin/sp/sites/check-archived?siteId=abc123
```

**Respuesta (200) - Sitio archivado:**
```json
{
  "siteId": "abc123",
  "isArchived": true,
  "archived": {
    "id": 1,
    "siteId": "abc123",
    "siteUrl": "https://tenant.sharepoint.com/sites/proyecto1",
    "siteName": "Proyecto Demo",
    "archivedAt": "2026-01-15T10:00:00.000Z",
    "archivedBy": "admin@company.com",
    "hubId": "hub123",
    "status": "archived"
  }
}
```

**Respuesta (200) - Sitio NO archivado:**
```json
{
  "siteId": "abc123",
  "isArchived": false
}
```

**Errores:**
- `400` - Falta siteId
- `500` - Error de servidor

---

## 🗄️ Estructura de Base de Datos

### Tabla: `archived_sites`

```sql
CREATE TABLE archived_sites (
  id INT PRIMARY KEY AUTO_INCREMENT,
  site_id VARCHAR(255) NOT NULL UNIQUE,
  site_url TEXT NOT NULL,
  site_name VARCHAR(500),
  archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  archived_by VARCHAR(255),
  hub_id VARCHAR(255),
  metadata JSON,
  status VARCHAR(50) DEFAULT 'archived',
  INDEX idx_site_id (site_id),
  INDEX idx_archived_at (archived_at),
  INDEX idx_hub_id (hub_id)
);
```

### Tabla de Auditoría: `archived_sites_audit` (opcional)

Registra automáticamente todas las operaciones de archivado/restauración mediante triggers.

---

## 🔄 Flujo de Uso

### Escenario 1: Archivar un sitio
```javascript
// Frontend
const archiveSite = async (siteId, siteUrl, siteName) => {
  const response = await fetch('/api/admin/sp/sites/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId, siteUrl, siteName })
  });
  return await response.json();
};

// Uso
const result = await archiveSite(
  'abc123-def456',
  'https://labit.sharepoint.com/sites/proyecto1',
  'Proyecto Demo'
);
```

### Escenario 2: Listar y filtrar archivados
```javascript
// Frontend
const getArchivedSites = async (hubId = null, page = 0) => {
  const limit = 25;
  const offset = page * limit;
  const url = `/api/admin/sp/sites/archived?limit=${limit}&offset=${offset}${hubId ? `&hubId=${hubId}` : ''}`;
  
  const response = await fetch(url);
  return await response.json();
};

// Uso
const archived = await getArchivedSites('hub123', 0);
console.log(`Total archivados: ${archived.total}`);
```

### Escenario 3: Verificar antes de mostrar
```javascript
// Frontend - antes de renderizar un sitio
const checkIfArchived = async (siteId) => {
  const response = await fetch(`/api/admin/sp/sites/check-archived?siteId=${siteId}`);
  const data = await response.json();
  return data.isArchived;
};

// Uso en componente
const sites = await getAllSites();
for (const site of sites) {
  const isArchived = await checkIfArchived(site.id);
  if (!isArchived) {
    // Mostrar sitio activo
  }
}
```

### Escenario 4: Restaurar sitio
```javascript
// Frontend
const restoreSite = async (siteId) => {
  const response = await fetch('/api/admin/sp/sites/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId })
  });
  return await response.json();
};

// Uso
const restored = await restoreSite('abc123-def456');
console.log(`Sitio restaurado: ${restored.restored.siteName}`);
```

---

## 🎨 Integración con UI (BridgePanel)

### Botones recomendados:

```jsx
// Opción 1: Botón de archivar (recomendado)
<Button 
  icon="archive" 
  onClick={() => archiveSite(site.id, site.url, site.name)}
>
  Archivar
</Button>

// Opción 2: Botón de eliminar permanente (peligroso)
<Button 
  icon="delete" 
  danger
  onClick={() => deleteSite(site.id)}
  disabled // Deshabilitar por defecto
>
  Eliminar Permanentemente
</Button>
```

### Vista de archivados:
```jsx
// Nueva sección en el panel
<Tab label="Archivados">
  <ArchivedSitesList 
    onRestore={(siteId) => restoreSite(siteId)}
    onPermanentDelete={(siteId) => deleteSite(siteId)}
  />
</Tab>
```

---

## ✅ Ventajas del Sistema

1. **Seguridad**: Protege contra eliminaciones accidentales
2. **Reversible**: Restauración instantánea sin tocar SharePoint
3. **Auditoría**: Registro completo de quién archivó/restauró y cuándo
4. **Performance**: Sin llamadas a SharePoint Admin API
5. **Compliance**: Cumple con políticas de retención
6. **UX**: Los usuarios tienen más confianza al archivar vs eliminar

---

## 🔧 Instalación

1. **Crear tabla en base de datos:**
```bash
mysql -u user -p database < data/sql/create_archived_sites.sql
```

2. **Verificar variables de entorno:**
```bash
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=tu_usuario
MYSQL_PASSWORD=tu_password
MYSQL_DATABASE=labit_skylabdb1
```

3. **Reiniciar servidor:**
```bash
npm restart
```

---

## 📊 Métricas y Auditoría

El sistema incluye triggers automáticos que registran en `archived_sites_audit`:
- Quién archivó el sitio y cuándo
- Quién restauró el sitio y cuándo
- Metadata asociada a cada operación

Consulta de auditoría:
```sql
SELECT 
  site_id,
  action,
  performed_by,
  performed_at,
  JSON_EXTRACT(details, '$.site_name') as site_name
FROM archived_sites_audit
WHERE site_id = 'abc123'
ORDER BY performed_at DESC;
```

---

## 🚨 Importante

- **Soft Delete es la opción recomendada** para la mayoría de casos
- **Hard Delete** (`DELETE /api/sp/site`) solo debe usarse:
  - Con confirmación explícita del usuario
  - Para sitios de prueba/desarrollo
  - Cuando se cumplan políticas de retención
- Los sitios archivados **NO aparecen** en listados normales (debes filtrarlos manualmente en el front si los traes con Graph API)

---

## 📞 Soporte

Archivos modificados/creados:
- ✅ [services/admin.archive.service.js](../services/admin.archive.service.js)
- ✅ [controllers/admin.controller.js](../controllers/admin.controller.js)
- ✅ [routes/api/admin.js](../routes/api/admin.js)
- ✅ [data/sql/create_archived_sites.sql](../data/sql/create_archived_sites.sql)
