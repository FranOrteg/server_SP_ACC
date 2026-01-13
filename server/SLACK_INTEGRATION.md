# Integración con Slack - Creación Automática de Canales

## Descripción

Durante el proceso de creación de proyectos (SP + ACC + Skylab), el sistema ahora crea automáticamente un canal de Slack asociado al proyecto y añade todos los miembros definidos.

## Características

✅ **Creación automática de canales** durante:
- Creación de proyectos Twin (ACC + SP)
- Creación de proyectos solo ACC

✅ **Gestión automática de miembros**:
- Invitación automática de todos los miembros del proyecto
- Soporte para miembros de ACC y SP
- Validación de usuarios en Slack antes de invitar

✅ **Tolerancia a fallos**:
- Si Slack no está configurado, el proceso continúa sin errores
- Si falla la creación del canal, el proyecto se crea igualmente
- Logging detallado de todas las operaciones

## Configuración

### 1. Crear una Slack App

1. Ve a [https://api.slack.com/apps](https://api.slack.com/apps)
2. Haz clic en **"Create New App"** → **"From scratch"**
3. Nombre: `Skylab Project Manager` (o el que prefieras)
4. Selecciona tu workspace de Slack

### 2. Configurar Permisos (OAuth Scopes)

En **OAuth & Permissions**, añade los siguientes **Bot Token Scopes**:

#### Requeridos:
- `channels:manage` - Crear y gestionar canales públicos
- `channels:read` - Listar canales públicos
- `chat:write` - Enviar mensajes (opcional, para futuras notificaciones)
- `groups:write` - Crear y gestionar canales privados
- `users:read` - Leer información básica de usuarios
- `users:read.email` - Buscar usuarios por email

#### Opcionales (para funcionalidades futuras):
- `chat:write.public` - Escribir en canales sin ser miembro
- `im:write` - Enviar mensajes directos
- `files:write` - Compartir archivos

### 3. Instalar la App en tu Workspace

1. En **OAuth & Permissions**, haz clic en **"Install to Workspace"**
2. Autoriza los permisos solicitados
3. Copia el **Bot User OAuth Token** (empieza con `xoxb-`)

### 4. Configurar Variables de Entorno

Añade el token a tu archivo `.env`:

```bash
# Slack Configuration
SLACK_BOT_TOKEN=xoxb-tu-token-aqui
```

### 5. Reiniciar el Servidor

```bash
npm run dev
# o
npm start
```

## Uso

### Crear Proyecto Twin (ACC + SP)

```http
POST /api/admin/twin/create
Content-Type: application/json

{
  "hubId": "b.1bb899d4-...",
  "templateId": "labit-standard",
  "vars": { 
    "code": "PROJ01", 
    "name": "Mi Proyecto" 
  },
  "sp": {
    "url": "https://tenant.sharepoint.com/sites/PRJ-PROJ01-Mi-Proyecto",
    "type": "CommunicationSite"
  },
  "members": [
    { "user": "usuario1@empresa.com", "role": "Owner" },
    { "user": "usuario2@empresa.com", "role": "Member" }
  ]
}
```

### Crear Proyecto ACC

```http
POST /api/admin/acc/projects/create
Content-Type: application/json

{
  "hubId": "b.1bb899d4-...",
  "templateId": "labit-standard-ACC",
  "vars": { 
    "code": "PROJ01", 
    "name": "Mi Proyecto" 
  },
  "accMembers": [
    { "email": "usuario1@empresa.com", "makeProjectAdmin": true, "grantDocs": "admin" },
    { "email": "usuario2@empresa.com", "makeProjectAdmin": false, "grantDocs": "member" }
  ]
}
```

## Respuesta

Ambos endpoints ahora incluyen información del canal de Slack creado:

```json
{
  "ok": true,
  "name": "PROJ01-Mi Proyecto",
  "link": { ... },
  "acc": { ... },
  "sp": { ... },
  "slack": {
    "ok": true,
    "channel": {
      "id": "C05ABC123DEF",
      "name": "proj01",
      "isPrivate": false,
      "created": true
    },
    "members": {
      "invited": 2,
      "failed": 0,
      "details": {
        "invited": [
          { "email": "usuario1@empresa.com", "userId": "U05XYZ..." },
          { "email": "usuario2@empresa.com", "userId": "U05ABC..." }
        ],
        "failed": []
      }
    }
  }
}
```

### Respuesta cuando Slack no está configurado:

```json
{
  "ok": true,
  "name": "PROJ01-Mi Proyecto",
  "link": { ... },
  "acc": { ... },
  "sp": { ... },
  "slack": {
    "ok": false,
    "skipped": true,
    "reason": "Slack no configurado"
  }
}
```

## Comportamiento del Sistema

### Nombres de Canales

Los nombres de canales se generan automáticamente:
- Formato: **Solo el código del proyecto** (sin prefijos ni sufijos)
- Conversión a minúsculas
- Espacios y caracteres especiales → guiones
- Máximo 80 caracteres (límite de Slack)

Ejemplos:
- Código: `PROJ01` → Canal: `proj01`
- Código: `ABC-123` → Canal: `abc-123`
- Código: `LAB_2025` → Canal: `lab-2025`

**Nota**: Si no se proporciona código, se usa el nombre del proyecto normalizado.

### Invitación de Miembros

1. Se busca cada usuario por email en Slack
2. Si el usuario existe, se invita al canal
3. Si el usuario no existe en Slack, se registra en `failed`
4. Si el usuario ya es miembro, se marca como `alreadyMember`

### Manejo de Errores

- **Canal ya existe**: Se reutiliza el canal existente
- **Usuario no encontrado**: Se continúa con los demás
- **Slack no configurado**: El proyecto se crea sin canal
- **Error en la API**: Se registra pero no falla el proyecto

## Logs

El sistema registra todas las operaciones:

```
[SLACK] INFO: Creando canal de Slack { channelName: 'proj01', isPrivate: false }
[SLACK] INFO: Canal de Slack creado exitosamente { id: 'C05...', name: 'proj01', created: true }
[SLACK] INFO: Invitando usuarios al canal { channelId: 'C05...', count: 2 }
[SLACK] INFO: Invitaciones completadas { channelId: 'C05...', invited: 2, failed: 0 }
[TWIN-CTRL] INFO: Canal de Slack creado { channelId: 'C05...', channelName: 'proj01', membersInvited: 2 }
```

## Arquitectura

### Archivos Creados

```
server/
├── clients/
│   └── slackClient.js          # Cliente HTTP para Slack API
├── services/
│   └── slack.service.js        # Lógica de negocio de Slack
└── controllers/
    └── admin.controller.js     # Integración en createTwin y createAccProject
```

### Funciones Principales

#### `slackClient.js`
- `apiPost(endpoint, body)` - POST a Slack API
- `apiGet(endpoint, params)` - GET de Slack API
- `isConfigured()` - Verifica si el token está configurado

#### `slack.service.js`
- `createChannel({ name, description, isPrivate })` - Crea un canal
- `inviteUsersToChannel(channelId, emails)` - Invita usuarios
- `createProjectChannel({ projectName, projectCode, ... })` - Flujo completo
- `normalizeChannelName(name)` - Normaliza nombres para Slack

## Troubleshooting

### Error: "SLACK_BOT_TOKEN no configurado"

**Causa**: La variable de entorno no está definida.

**Solución**:
```bash
echo "SLACK_BOT_TOKEN=xoxb-tu-token" >> .env
```

### Error: "missing_scope"

**Causa**: El bot no tiene los permisos necesarios.

**Solución**:
1. Ve a [https://api.slack.com/apps](https://api.slack.com/apps)
2. Selecciona tu app
3. **OAuth & Permissions** → Añade los scopes faltantes
4. **Reinstall App** para actualizar permisos

### Error: "users_not_found"

**Causa**: El email no corresponde a ningún usuario de Slack.

**Comportamiento**: Se registra en `failed` pero el proyecto se crea.

**Solución**: Verifica que el usuario tenga cuenta en el workspace de Slack.

### Canal ya existe

**Causa**: Ya hay un canal con ese nombre.

**Comportamiento**: Se reutiliza el canal existente y se marca `created: false, existed: true`.

**Nota**: Los nuevos miembros se invitan igualmente.

## Próximas Mejoras

- [ ] Notificaciones automáticas al canal cuando se sube un archivo
- [ ] Integración con eventos de ACC/SP
- [ ] Comandos slash para gestionar proyectos desde Slack
- [ ] Webhooks para actualizaciones bidireccionales
- [ ] Archivado automático de canales cuando se cierra el proyecto

## Seguridad

⚠️ **Importante**:
- Nunca subas el `SLACK_BOT_TOKEN` a repositorios públicos
- Usa variables de entorno o secretos de Azure/AWS
- Rota el token periódicamente
- Limita los permisos al mínimo necesario

## Referencias

- [Slack API Documentation](https://api.slack.com/)
- [Slack Bot Tokens](https://api.slack.com/authentication/token-types)
- [OAuth Scopes](https://api.slack.com/scopes)
