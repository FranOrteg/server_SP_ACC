# Configuración de Límite de Versiones en SharePoint

## Descripción del Requisito

Al crear un nuevo sitio de SharePoint, la biblioteca de documentos "Documents" (Shared Documents) debe configurarse con un límite de **5 versiones principales** en lugar del valor predeterminado de 500.

---

## Endpoint a Modificar

**Archivo Backend:** El endpoint `POST /api/admin/sp/sites/create`

**Flujo Actual:**
1. Crear sitio desde template
2. Configurar miembros
3. (Opcional) Crear canal de Slack

**Flujo Propuesto:**
1. Crear sitio desde template
2. **Nuevo:** Configurar límite de versiones en biblioteca "Documents"
3. Configurar miembros
4. (Opcional) Crear canal de Slack

---

## Microsoft Graph API - Configurar Versiones de Biblioteca

### Paso 1: Obtener el ID del Sitio (ya lo tienes)

```http
GET https://graph.microsoft.com/v1.0/sites/{hostname}:/sites/{sitePath}
```

Ejemplo:
```http
GET https://graph.microsoft.com/v1.0/sites/labitgroup.sharepoint.com:/sites/PRJ-TestProject
```

### Paso 2: Obtener la Lista "Documents"

```http
GET https://graph.microsoft.com/v1.0/sites/{site-id}/lists?$filter=displayName eq 'Documents' or displayName eq 'Documentos'
```

**Nota:** El nombre puede ser "Documents" (EN) o "Documentos" (ES) dependiendo del idioma del template.

Respuesta:
```json
{
  "value": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "displayName": "Documents",
      "name": "Shared Documents"
    }
  ]
}
```

### Paso 3: Actualizar Configuración de Versiones

```http
PATCH https://graph.microsoft.com/v1.0/sites/{site-id}/lists/{list-id}
Content-Type: application/json

{
  "list": {
    "versioningConfiguration": {
      "majorVersionLimit": 5
    }
  }
}
```

**Headers requeridos:**
```
Authorization: Bearer {access_token}
Content-Type: application/json
```

---

## Implementación Backend (Node.js Ejemplo)

```javascript
async function configureVersionLimit(siteId, versionLimit = 5) {
  // 1. Obtener la lista "Documents" (puede ser "Documents" o "Documentos")
  const listsUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists`;
  const listsResponse = await graphClient.get(listsUrl);
  
  const documentsList = listsResponse.value.find(list => 
    list.displayName === 'Documents' || 
    list.displayName === 'Documentos' ||
    list.name === 'Shared Documents'
  );
  
  if (!documentsList) {
    console.warn('No se encontró la biblioteca Documents');
    return { success: false, error: 'Documents library not found' };
  }
  
  // 2. Actualizar configuración de versiones
  const patchUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${documentsList.id}`;
  
  const patchBody = {
    list: {
      versioningConfiguration: {
        majorVersionLimit: versionLimit
      }
    }
  };
  
  await graphClient.patch(patchUrl, patchBody);
  
  return { success: true, listId: documentsList.id, versionLimit };
}
```

---

## Opciones de Implementación

### Opción A: Siempre aplicar 5 versiones (Recomendado)

Modificar el backend para que **siempre** configure el límite a 5 versiones después de crear cualquier sitio. No requiere cambios en el frontend.

```javascript
// En el handler de POST /api/admin/sp/sites/create
async function createSite(req, res) {
  // ... código existente para crear sitio ...
  
  const siteId = await createSiteFromTemplate(payload);
  
  // NUEVO: Configurar límite de versiones
  try {
    await configureVersionLimit(siteId, 5);
    console.log(`Version limit set to 5 for site ${siteId}`);
  } catch (err) {
    console.warn(`Could not set version limit: ${err.message}`);
    // No fallar la creación del sitio por esto
  }
  
  // ... resto del código ...
}
```

## Permisos Requeridos (Microsoft Graph)

La aplicación registrada en Azure AD debe tener el permiso:

- **Sites.ReadWrite.All** (Application permission)

Este permiso ya debería estar configurado si el backend puede crear sitios.

---

## Consideraciones

1. **Timing:** La configuración debe hacerse después de que el sitio esté completamente provisionado. Puede necesitar un pequeño delay (1-2 segundos) después de la creación.

2. **Bibliotecas adicionales:** Si el template crea múltiples bibliotecas de documentos, considera si todas deben tener el mismo límite.

3. **Error handling:** Si falla la configuración de versiones, el sitio ya está creado. Decide si:
   - Logear warning y continuar (recomendado)
   - Devolver error parcial al frontend

4. **Retroactividad:** Esta configuración solo aplica a **nuevos** sitios. Los sitios existentes mantendrán su configuración de 500 versiones.

---

## Verificación

Para verificar que la configuración se aplicó correctamente:

1. Ir al sitio de SharePoint
2. Ir a "Configuración del sitio" → "Bibliotecas de documentos" → "Documents"
3. "Configuración de biblioteca" → "Configuración de versiones"
4. Verificar que "Número máximo de versiones principales" = 5
