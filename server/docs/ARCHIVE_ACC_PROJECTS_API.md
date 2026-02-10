# API de Archivo de Proyectos ACC

Este documento describe los endpoints para archivar proyectos en Autodesk Construction Cloud (ACC).

## Endpoints

### 1. Archivar Proyecto (Combinado)

Endpoint principal que realiza todo el proceso de archivo: renombrar el proyecto y restringir permisos de miembros.

```
POST /api/admin/acc/projects/archive
```

#### Request Body

```json
{
  "hubId": "b.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "projectId": "b.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "options": {
    "renamePrefix": "Closed_",
    "restrictToDocsOnly": true,
    "removeFromProducts": [
      "designCollaboration",
      "modelCoordination", 
      "projectManagement",
      "costManagement",
      "fieldManagement"
    ]
  }
}
```

#### Parámetros

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `hubId` | string | Sí | ID del hub ACC (con o sin prefijo "b.") |
| `projectId` | string | Sí | ID del proyecto ACC (con o sin prefijo "b.") |
| `options.renamePrefix` | string | No | Prefijo para el nuevo nombre (default: "Closed_") |
| `options.restrictToDocsOnly` | boolean | No | Si restringir permisos solo a Docs (default: true) |
| `options.removeFromProducts` | string[] | No | Productos a remover de los usuarios |

#### Productos ACC disponibles

- `docs` - Document Management (se mantiene)
- `designCollaboration` - Design Collaboration
- `modelCoordination` - Model Coordination
- `projectManagement` - Project Management
- `costManagement` - Cost Management
- `fieldManagement` - Field Management

#### Response (Éxito)

```json
{
  "success": true,
  "archived": {
    "projectId": "b.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "newName": "Closed_NombreProyecto",
    "previousName": "NombreProyecto",
    "renamedAt": "2026-02-10T12:00:00.000Z"
  },
  "permissions": {
    "totalMembers": 15,
    "membersModified": 12,
    "membersSkipped": 3,
    "details": [
      {
        "userId": "abc123",
        "email": "user@example.com",
        "name": "User Name",
        "status": "modified",
        "productsRemoved": ["designCollaboration", "modelCoordination"],
        "productsKept": ["docs"]
      },
      {
        "userId": "def456",
        "email": "viewer@example.com",
        "name": "Viewer User",
        "status": "skipped",
        "productsRemoved": [],
        "productsKept": ["docs"],
        "reason": "No products to remove"
      }
    ]
  }
}
```

#### Response (Error Parcial - 207)

```json
{
  "success": false,
  "archived": {
    "projectId": "b.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "newName": "Closed_NombreProyecto",
    "previousName": "NombreProyecto",
    "renamedAt": "2026-02-10T12:00:00.000Z"
  },
  "permissions": null,
  "errors": [
    {
      "phase": "permissions",
      "error": "Failed to update user permissions",
      "code": "PERMISSIONS_UPDATE_FAILED"
    }
  ]
}
```

#### Response (Error)

```json
{
  "success": false,
  "error": "Failed to rename project",
  "code": "ARCHIVE_FAILED"
}
```

---

### 2. Renombrar Proyecto

Endpoint individual para solo renombrar un proyecto ACC.

```
PATCH /api/admin/acc/projects/:projectId/rename
```

#### URL Parameters

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `projectId` | string | ID del proyecto ACC |

#### Request Body

```json
{
  "hubId": "b.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "newName": "Closed_NombreProyecto"
}
```

#### Response (Éxito)

```json
{
  "success": true,
  "project": {
    "id": "b.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "name": "Closed_NombreProyecto",
    "previousName": "NombreProyecto"
  }
}
```

#### Response (Error)

```json
{
  "success": false,
  "error": "Project name already exists with Closed_ prefix",
  "code": "RENAME_FAILED"
}
```

---

### 3. Obtener Usuarios de Proyecto

Endpoint auxiliar para listar los usuarios de un proyecto ACC.

```
GET /api/admin/acc/projects/:projectId/users
```

#### URL Parameters

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `projectId` | string | ID del proyecto ACC |

#### Response

```json
{
  "success": true,
  "total": 15,
  "users": [
    {
      "id": "abc123",
      "email": "user@example.com",
      "name": "User Name",
      "status": "active",
      "products": [
        { "key": "docs", "access": "administrator" },
        { "key": "designCollaboration", "access": "member" }
      ]
    }
  ]
}
```

---

## APIs de Autodesk Utilizadas

### Renombrar Proyecto
```
PATCH https://developer.api.autodesk.com/project/v1/hubs/:hub_id/projects/:project_id
```

### Listar Usuarios del Proyecto
```
GET https://developer.api.autodesk.com/construction/admin/v2/projects/:projectId/users
```

### Actualizar Acceso de Usuario
```
PATCH https://developer.api.autodesk.com/construction/admin/v2/projects/:projectId/users/:userId
```

---

## Notas de Implementación

1. **Prefijo de archivo**: El sistema verifica si el proyecto ya tiene el prefijo antes de renombrar para evitar dobles prefijos (ej: "Closed_Closed_Proyecto").

2. **Permisos**: Solo se modifican los usuarios que tienen productos en la lista `removeFromProducts`. Los usuarios que solo tienen acceso a `docs` se omiten.

3. **Transaccionalidad**: El proceso NO es transaccional. Si falla el renombrado, no se intentan los permisos. Si falla algún permiso individual, los demás continúan.

4. **Autenticación**: Requiere OAuth 3LO (3-legged) con permisos de administración de proyectos.
