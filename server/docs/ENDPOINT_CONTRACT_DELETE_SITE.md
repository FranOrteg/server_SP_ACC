# 🗑️ Contrato del Endpoint - Eliminar Sitio de SharePoint

## 📋 Objetivo

Implementar un endpoint que permita eliminar sitios de SharePoint de forma permanente utilizando la SharePoint Admin API.

**Nota:** Los sitios eliminados van a la papelera de reciclaje de SharePoint por 93 días, desde donde un administrador puede restaurarlos.

---

## 📡 Endpoint Requerido

```
DELETE /api/admin/sp/sites/delete
```

**IMPORTANTE:** El frontend ahora llama a `/api/admin/sp/sites/delete` (antes era `/api/sp/site`)

---

## 📥 Query Parameters

| Parámetro | Tipo   | Obligatorio | Descripción |
|-----------|--------|-------------|-------------|
| `siteId`  | string | ✅ Sí       | ID del sitio de SharePoint a eliminar |

**Ejemplo de llamada:**
```
DELETE /api/admin/sp/sites/delete?siteId=bfae71c2-e44c-43cc-b9fa-a6d084bcd7f5
```

---

## ✅ Respuesta Exitosa (200)

```json
{
  "ok": true,
  "deleted": {
    "siteId": "bfae71c2-e44c-43cc-b9fa-a6d084bcd7f5",
    "deletedAt": "2026-01-26T12:00:00.000Z"
  },
  "message": "Sitio eliminado correctamente. Irá a la papelera de reciclaje de SharePoint por 93 días."
}
```

---

## ❌ Respuestas de Error

### Error 400 - Bad Request
```json
{
  "error": "siteId es requerido"
}
```

### Error 404 - Not Found
```json
{
  "error": "Sitio no encontrado"
}
```

### Error 403 - Forbidden
```json
{
  "error": "No tienes permisos para eliminar este sitio"
}
```

### Error 500 - Internal Server Error
```json
{
  "error": "Error al eliminar sitio: [mensaje del error de SharePoint Admin API]"
}
```

---

## 🔧 Implementación Completa Backend

### 📁 Estructura de Archivos

```
server/
├── routes/
│   └── api/
│       └── admin.js              # Rutas de administración
├── controllers/
│   └── admin.controller.js       # Controlador del endpoint
├── services/
│   └── sp-admin.service.js       # Lógica de SharePoint Admin API
└── middleware/
    └── auth.middleware.js        # Autenticación (si es necesario)
```

---

### 1️⃣ Ruta - `routes/api/admin.js`

```javascript
const express = require('express');
const router = express.Router();
const adminController = require('../../controllers/admin.controller');

// Middleware de autenticación (si es necesario)
// const { requireAuth } = require('../../middleware/auth.middleware');
// router.use(requireAuth);

// Endpoint para eliminar sitio de SharePoint
router.delete('/sp/sites/delete', adminController.deleteSite);

module.exports = router;
```

**Importante:** Asegúrate de que esta ruta esté registrada en tu `app.js` o `server.js`:

```javascript
const adminRoutes = require('./routes/api/admin');
app.use('/api/admin', adminRoutes);
```

---

### 2️⃣ Controlador - `controllers/admin.controller.js`

```javascript
const spAdminService = require('../services/sp-admin.service');

/**
 * Elimina un sitio de SharePoint de forma permanente
 * @route DELETE /api/admin/sp/sites/delete
 * @queryparam {string} siteId - ID del sitio a eliminar
 */
async function deleteSite(req, res) {
  try {
    const { siteId } = req.query;
    
    console.log('🗑️ Solicitud de eliminación de sitio:', {
      siteId,
      timestamp: new Date().toISOString(),
      user: req.user?.email || 'unknown'
    });
    
    // Validación
    if (!siteId) {
      console.warn('⚠️ Solicitud sin siteId');
      return res.status(400).json({ 
        error: 'siteId es requerido' 
      });
    }

    // Validar formato de UUID (opcional pero recomendado)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(siteId)) {
      console.warn('⚠️ Formato de siteId inválido:', siteId);
      return res.status(400).json({ 
        error: 'Formato de siteId inválido. Debe ser un UUID.' 
      });
    }

    // Llamar al servicio de SharePoint Admin
    const result = await spAdminService.deleteSite(siteId);
    
    console.log('✅ Sitio eliminado correctamente:', {
      siteId,
      result
    });
    
    return res.status(200).json({
      ok: true,
      deleted: {
        siteId,
        deletedAt: new Date().toISOString()
      },
      message: 'Sitio eliminado correctamente. Irá a la papelera de reciclaje de SharePoint por 93 días.'
    });
    
  } catch (error) {
    console.error('❌ Error al eliminar sitio:', {
      siteId: req.query.siteId,
      error: error.message,
      stack: error.stack,
      response: error.response?.data
    });
    
    // Manejar errores específicos de SharePoint
    if (error.statusCode === 404 || error.response?.status === 404) {
      return res.status(404).json({ 
        error: 'Sitio no encontrado en SharePoint' 
      });
    }
    
    if (error.statusCode === 403 || error.response?.status === 403) {
      return res.status(403).json({ 
        error: 'No tienes permisos para eliminar este sitio' 
      });
    }

    if (error.statusCode === 429 || error.response?.status === 429) {
      return res.status(429).json({ 
        error: 'Demasiadas solicitudes. Intenta de nuevo en unos momentos.' 
      });
    }
    
    return res.status(500).json({ 
      error: `Error al eliminar sitio: ${error.message}` 
    });
  }
}

module.exports = {
  deleteSite,
  // ... otros métodos del controlador
};
```

---

### 3️⃣ Servicio - `services/sp-admin.service.js`

```javascript
const axios = require('axios');
const msal = require('@azure/msal-node');
const fs = require('fs');
const path = require('path');

// Configuración de Azure AD y SharePoint
const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CERT_THUMBPRINT = process.env.AZURE_CERT_THUMBPRINT;
const CERT_PRIVATE_KEY_PATH = process.env.AZURE_CERT_PRIVATE_KEY_PATH;
const TENANT = process.env.SHAREPOINT_TENANT; // Ej: "labitgroup"

// Cliente MSAL para autenticación con certificado
const msalConfig = {
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    clientCertificate: {
      thumbprint: CERT_THUMBPRINT,
      privateKey: fs.readFileSync(path.resolve(CERT_PRIVATE_KEY_PATH), 'utf8')
    }
  }
};

const cca = new msal.ConfidentialClientApplication(msalConfig);

/**
 * Obtiene un token de acceso para SharePoint Admin API
 * @returns {Promise<string>} Access token
 */
async function getSharePointAdminToken() {
  try {
    const tokenRequest = {
      scopes: [`https://${TENANT}-admin.sharepoint.com/.default`]
    };

    const response = await cca.acquireTokenByClientCredential(tokenRequest);
    
    if (!response || !response.accessToken) {
      throw new Error('No se pudo obtener el token de acceso');
    }

    console.log('🔑 Token de SharePoint Admin obtenido correctamente');
    return response.accessToken;
    
  } catch (error) {
    console.error('❌ Error obteniendo token de SharePoint Admin:', error);
    throw new Error(`Error de autenticación: ${error.message}`);
  }
}

/**
 * Elimina un sitio de SharePoint usando la Admin API
 * @param {string} siteId - UUID del sitio a eliminar
 * @returns {Promise<Object>} Resultado de la operación
 */
async function deleteSite(siteId) {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Intento ${attempt}/${maxRetries} - Eliminando sitio:`, siteId);
      
      // 1. Obtener token de SharePoint Admin
      const token = await getSharePointAdminToken();
      
      // 2. Construir URL del tenant admin
      const tenantAdminUrl = `https://${TENANT}-admin.sharepoint.com`;
      
      // 3. Llamar a la API de eliminación de SharePoint
      const response = await axios({
        method: 'POST',
        url: `${tenantAdminUrl}/_api/SPSiteManager/delete`,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        data: {
          siteId: siteId
        },
        timeout: 30000, // 30 segundos de timeout
        validateStatus: (status) => status < 600 // No lanzar error automáticamente
      });
      
      // 4. Verificar respuesta
      if (response.status === 200 || response.status === 204) {
        console.log('✅ Sitio eliminado correctamente en SharePoint:', siteId);
        return {
          success: true,
          siteId,
          deletedAt: new Date().toISOString()
        };
      }
      
      // Si el status no es exitoso, lanzar error con el status
      const error = new Error(`SharePoint API respondió con status ${response.status}`);
      error.statusCode = response.status;
      error.response = response;
      throw error;
      
    } catch (error) {
      lastError = error;
      
      console.warn(`⚠️ Intento ${attempt}/${maxRetries} falló:`, {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      
      // No reintentar en ciertos errores (cliente/validación)
      if (error.response?.status && error.response.status < 500) {
        throw error; // 4xx errors no se reintentan
      }
      
      // Esperar antes de reintentar (backoff exponencial)
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.log(`⏳ Esperando ${delay}ms antes del siguiente intento...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // Si llegamos aquí, todos los reintentos fallaron
  console.error('❌ Todos los intentos de eliminación fallaron');
  throw lastError;
}

module.exports = {
  deleteSite,
  getSharePointAdminToken
};
```

---

## � Configuración de Variables de Entorno

Agregar estas variables al archivo `.env` del servidor:

```bash
# Azure AD - App Registration
AZURE_TENANT_ID=tu-tenant-id
AZURE_CLIENT_ID=tu-client-id
AZURE_CERT_THUMBPRINT=tu-cert-thumbprint
AZURE_CERT_PRIVATE_KEY_PATH=/path/to/private-key.pem

# SharePoint
SHAREPOINT_TENANT=labitgroup
```

---

## 📦 Dependencias Requeridas

Instalar las siguientes dependencias npm:

```bash
npm install @azure/msal-node axios
```

**package.json:**
```json
{
  "dependencies": {
    "@azure/msal-node": "^2.0.0",
    "axios": "^1.6.0",
    "express": "^4.18.0"
  }
}
```

---

```
┌─────────────────────────────────────────────────────────┐
│  Frontend: Usuario pulsa "Eliminar sitio"               │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Modal de confirmación con advertencias                 │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼ Usuario confirma
                     │
    DELETE /api/admin/sp/sites/delete?siteId=xxx
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Backend: Obtiene token SharePoint Admin                │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Backend: Llama a /_api/SPSiteManager/delete            │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  SharePoint: Sitio movido a papelera (93 días)          │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Frontend: Muestra mensaje de éxito, refresca lista     │
└─────────────────────────────────────────────────────────┘
```

---

## ⚠️ Consideraciones Importantes

1. **Papelera de SharePoint**: Los sitios eliminados van a la papelera de reciclaje del tenant por **93 días**. Durante ese tiempo, un administrador puede restaurarlos desde SharePoint Admin Center.

2. **Permisos requeridos**: La aplicación necesita permisos de **SharePoint Admin** para poder eliminar sitios:
   - `Sites.FullControl.All` (Application permission)
   - O ser **SharePoint Administrator** en el tenant

3. **Autenticación**: Usa autenticación con certificado para la SharePoint Admin API (no OAuth de usuario).

4. **Reintentos**: Implementar reintentos automáticos (2-3 intentos) con backoff exponencial para errores transitorios (429, 500+).

5. **Timeout**: Configurar timeout de 30 segundos para la operación.

---

## 📊 Logging Recomendado

```javascript
// Logs informativos
console.log('🗑️ Iniciando eliminación de sitio:', siteId);
console.log('🔑 Token obtenido para SharePoint Admin');
console.log('📤 Llamando a SPSiteManager/delete');
console.log('✅ Sitio eliminado correctamente');

// Logs de error
console.error('❌ Error obteniendo token:', error);
console.error('❌ Error en SharePoint Admin API:', error);
```

---

## ✅ Checklist de Implementación

- [ ] Instalar dependencias: `@azure/msal-node`, `axios`
- [ ] Configurar variables de entorno en `.env`
- [ ] Crear archivo `services/sp-admin.service.js`
- [ ] Crear/actualizar `controllers/admin.controller.js`
- [ ] Crear/actualizar `routes/api/admin.js`
- [ ] Registrar ruta en `app.js`: `app.use('/api/admin', adminRoutes)`
- [ ] Verificar que el certificado está en el servidor
- [ ] Verificar permisos de la App en Azure AD: `Sites.FullControl.All`
- [ ] Testing del endpoint con Postman/curl
- [ ] Verificar logs en consola
- [ ] Probar desde el frontend

---

## 🧪 Testing

### Caso de prueba 1: Eliminación exitosa
```bash
curl -X DELETE "http://localhost:3000/api/admin/sp/sites/delete?siteId=bfae71c2-e44c-43cc-b9fa-a6d084bcd7f5"
```
**Esperado:** 200 con mensaje de éxito

### Caso de prueba 2: Sin siteId
```bash
curl -X DELETE "http://localhost:3000/api/admin/sp/sites/delete"
```
**Esperado:** 400 con "siteId es requerido"

### Caso de prueba 3: Sitio no existe
```bash
curl -X DELETE "http://localhost:3000/api/admin/sp/sites/delete?siteId=no-existe"
```
**Esperado:** 404 con "Sitio no encontrado"

---

## 📝 Cambios en Frontend (Ya Realizados)

El frontend ya ha sido actualizado:
- ✅ Eliminada importación de `spArchiveSite`
- ✅ Eliminadas variables y funciones de archivado
- ✅ Simplificada la UI a solo botón de eliminar
- ✅ Actualizada la ruta del endpoint a `/api/admin/sp/sites/delete`
- ✅ Modal de confirmación solo para eliminación
