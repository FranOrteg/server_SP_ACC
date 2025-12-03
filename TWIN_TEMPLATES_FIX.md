# Fix: Twin Apply duplicando plantillas en ACC

## 🐛 Problema identificado

Cuando se creaban proyectos Twin con plantillas diferentes para ACC y SharePoint, el endpoint `/api/admin/twin/apply` estaba **duplicando carpetas en ACC**.

### Flujo problemático anterior:

1. **POST `/api/admin/acc/projects/create`** con `templateId: "labit-standard-ACC"`
   - ✅ Crea proyecto ACC
   - ✅ Aplica carpetas de "labit-standard-ACC" (33 carpetas)

2. **POST `/api/admin/sp/sites/create`** con `templateId: "labit-standard-SP"`
   - ✅ Crea sitio SP
   - ✅ Aplica carpetas de "labit-standard-SP" (4 carpetas)

3. **POST `/api/admin/twin/apply`** con `templateId: "labit-standard-SP"`
   - ❌ **Aplicaba "labit-standard-SP" OTRA VEZ en ACC** (carpetas duplicadas: 33 + 4 = 37)
   - ❌ Aplicaba "labit-standard-SP" en SP (ya estaban creadas)
   - ✅ Guardaba el vínculo Twin

### Causa raíz:

El endpoint `applyTwin` estaba diseñado para aplicar **la misma plantilla** en ambos lados (ACC y SP), lo cual tenía sentido para casos donde ACC y SP comparten estructura. 

Sin embargo, cuando se usan plantillas diferentes:
- ACC: `labit-standard-ACC` (estructura BIM completa)
- SP: `labit-standard-SP` (estructura simple de documentos)

El endpoint aplicaba la última plantilla (SP) sobre ACC, duplicando carpetas.

## ✅ Solución implementada

Se modificó `applyTwin` para que **por defecto solo vincule** sin aplicar plantillas:

### Cambios en el código:

```javascript
async function applyTwin(req, res, next) {
  const { 
    projectId, accountId, hubId, siteId, siteUrl, 
    templateId, vars = {}, twinId,
    applyTemplates = false  // ⚠️ NUEVO: Por defecto solo vincula
  } = req.body || {};
  
  // Solo aplica plantillas si applyTemplates=true
  if (applyTemplates && templateId) {
    // Aplica la misma plantilla en ACC y SP
  }
  
  // Siempre guarda el vínculo Twin
  const link = await twinSvc.saveLink({ ... });
}
```

### Flujo correcto ahora:

1. **POST `/api/admin/acc/projects/create`** con `templateId: "labit-standard-ACC"`
   - ✅ Crea proyecto ACC
   - ✅ Aplica carpetas de "labit-standard-ACC" (33 carpetas)

2. **POST `/api/admin/sp/sites/create`** con `templateId: "labit-standard-SP"`
   - ✅ Crea sitio SP
   - ✅ Aplica carpetas de "labit-standard-SP" (4 carpetas)

3. **POST `/api/admin/twin/apply`** (sin `applyTemplates`)
   - ✅ **SOLO vincula** ACC ↔ SP
   - ✅ NO modifica carpetas en ACC
   - ✅ NO modifica carpetas en SP

## 📝 Uso desde el Frontend (TwinPanel.svelte)

### Opción A: Plantillas diferentes (recomendado)

```javascript
// 1. Crear proyecto ACC con su plantilla
const accResponse = await fetch('/api/admin/acc/projects/create', {
  method: 'POST',
  body: JSON.stringify({
    hubId: "b.1bb899d4-8dd4-42d8-aefd-6c0e35acd825",
    templateId: "labit-standard-ACC",  // ← Plantilla ACC
    vars: { timeLabitCode: "21005", code: "AEMD01", name: "Test Project" },
    memberEmail: "support@labit.es"
  })
});

// 2. Crear sitio SharePoint con su plantilla
const spResponse = await fetch('/api/admin/sp/sites/create', {
  method: 'POST',
  body: JSON.stringify({
    templateId: "labit-standard-SP",  // ← Plantilla SP (diferente)
    type: "CommunicationSite",
    url: "https://labitgroup.sharepoint.com/sites/PRJ-AEMD01-test",
    vars: { timeLabitCode: "21005", code: "AEMD01", name: "Test Project" },
    members: [...]
  })
});

// 3. Vincular Twin (SOLO linking, sin aplicar plantillas)
const twinResponse = await fetch('/api/admin/twin/apply', {
  method: 'POST',
  body: JSON.stringify({
    projectId: accResponse.projectId,
    siteUrl: spResponse.webUrl,
    twinId: "PRJ-AEMD01-test"
    // ⚠️ NO incluir templateId ni applyTemplates
  })
});
```

### Opción B: Misma plantilla para ambos (raro)

Si ACC y SP deben tener la misma estructura:

```javascript
const twinResponse = await fetch('/api/admin/twin/apply', {
  method: 'POST',
  body: JSON.stringify({
    projectId: accResponse.projectId,
    siteUrl: spResponse.webUrl,
    templateId: "labit-standard-SHARED",  // ← Misma plantilla
    vars: { timeLabitCode: "21005", code: "AEMD01", name: "Test Project" },
    accountId: "1bb899d4-8dd4-42d8-aefd-6c0e35acd825",
    applyTemplates: true,  // ⚠️ Aplicar plantilla en ambos
    twinId: "PRJ-AEMD01-test"
  })
});
```

## 🔍 Debugging

### Verificar carpetas creadas en ACC:

```http
GET /api/acc/projects/{projectId}/folders
```

### Verificar carpetas creadas en SharePoint:

```http
GET /api/sp/sites/{siteId}/folders
```

### Verificar vínculo Twin:

```http
GET /api/admin/twin/{twinId}/status
```

## 📋 Checklist de validación

- [ ] ACC tiene SOLO carpetas de `labit-standard-ACC` (33 carpetas)
- [ ] SharePoint tiene SOLO carpetas de `labit-standard-SP` (4 carpetas)
- [ ] Twin está vinculado correctamente (status: green)
- [ ] No hay carpetas duplicadas en ningún lado

## 🎯 Archivos modificados

- `server/controllers/admin.controller.js` - Función `applyTwin()` con parámetro `applyTemplates`
- `server/peticiones.rest` - Ejemplos actualizados con nuevos parámetros
- `TWIN_TEMPLATES_FIX.md` - Esta documentación

---

**Fecha del fix:** 3 de diciembre de 2025  
**Issue:** Duplicación de carpetas en ACC al vincular Twin con plantillas diferentes
