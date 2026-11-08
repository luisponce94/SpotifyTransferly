# MusicTransferly (SpotifyTransferly)

Aplicación local y de código abierto para transferir y migrar playlists y canciones de forma **bidireccional** entre **Spotify** y **YouTube Music** (así como entre dos cuentas de Spotify o dos cuentas de YouTube). Desarrollada con JavaScript, HTML5 y Tailwind CSS, con un servidor HTTP ligero en Node.js sin dependencias externas (`zero dependencies`).

---

## 🚀 Capacidades y Rutas Soportadas

1. 🟢 **Spotify ➔ 🔴 YouTube Music**: Lee tus listas de Spotify (incluyendo tus Me Gusta), busca los videos musicales en YouTube y crea las listas correspondientes en tu biblioteca de YouTube Music.
2. 🔴 **YouTube Music ➔ 🟢 Spotify**: Lee tus playlists de YouTube, normaliza y limpia los títulos ruidosos (eliminando etiquetas como `[Official Video]`, `(Audio)`, `HD`, `ft.`, etc.) y localiza las canciones en el catálogo de Spotify.
3. 🟢 **Spotify ➔ 🟢 Spotify**: Clona playlists completas y canciones favoritas entre dos cuentas independientes de Spotify.
4. 🔴 **YouTube Music ➔ 🔴 YouTube Music**: Clona playlists y videos musicales entre dos cuentas de Google/YouTube.
5. 💾 **Respaldo y Restauración Offline en JSON**: Exporta todas tus playlists y canciones a un archivo `.json` para guardarlas en tu equipo o restaurarlas en cualquier momento sin necesitar acceso simultáneo a la cuenta origen.

---

## 📸 Capturas de Pantalla

Las capturas fueron tomadas en un entorno local aislado sin datos personales ni tokens reales:

![Configuración inicial](docs/screenshots/01-configuracion.png)
![Conectar cuenta de origen](docs/screenshots/02-origen.png)
![Selección con datos ficticios](docs/screenshots/03-seleccion-demo.png)
![Cuenta de destino con datos ficticios](docs/screenshots/04-destino-demo.png)

---

## 💻 Requisitos y Ejecución Local

- **Node.js 20+ o 22+** y conexión a Internet.
- **Sin instalación previa**: No requiere `npm install` ni librerías de terceros en tiempo de ejecución.

```sh
npm start
```

O en Windows, haz doble clic en `iniciar.bat` o `start.bat`.
Abre tu navegador en `http://127.0.0.1:3000`.

---

## 🔑 Configuración de Credenciales (100% Gratis)

La aplicación utiliza el flujo estándar y seguro **OAuth 2.0 con PKCE (Proof Key for Code Exchange)**. **No se utiliza ningún Client Secret**.

### 1. Para Spotify:
1. Accede a [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) e inicia sesión con tu cuenta de Spotify.
2. Haz clic en **Create app**, dale un nombre (ej. `MusicTransferly`) y selecciona **Web API**.
3. En **Redirect URIs**, ingresa exactamente: `http://127.0.0.1:3000/callback`
4. Guarda y copia tu **Client ID** para pegarlo en la aplicación.
5. *(Modo Desarrollo)*: En **Settings > Users and Access**, agrega los correos de las cuentas de Spotify que utilizarás.

### 2. Para YouTube Music (Google Cloud):
1. Accede a [Google Cloud Console](https://console.cloud.google.com) y crea un proyecto gratuito.
2. En **APIs y servicios > Biblioteca**, busca **YouTube Data API v3** y actívala (**Habilitar**).
3. En **Pantalla de consentimiento de OAuth**, selecciona tipo *Externo* y agrega tu correo en *Usuarios de prueba*.
4. En **Credenciales > Crear credenciales > ID de cliente de OAuth**, selecciona tipo **Aplicación web**.
5. En **URIs de redireccionamiento autorizados**, añade exactamente: `http://127.0.0.1:3000/callback`
6. Guarda y copia el **ID de cliente** generado (termina en `.apps.googleusercontent.com`) y el **Secreto de cliente** (Client Secret).
7. *Nota sobre cuotas*: Google asigna 10,000 unidades de cuota gratuita diaria por proyecto. La app maneja automáticamente este límite pausando la transferencia sin pérdida de datos si la cuota del día se agota.

---

## 🔒 Privacidad y Seguridad Local

- **Zero External Server**: Todos los intercambios de credenciales ocurren entre tu navegador y los servidores oficiales de Spotify / Google a través del proxy local en `127.0.0.1:3000`.
- **Aislamiento de Tokens en `sessionStorage`**: Los tokens de acceso y actualización (`refresh_token`) se guardan temporalmente en `sessionStorage`, lo que garantiza que se eliminan por completo al cerrar la pestaña o el navegador.
- **Flujo PKCE & Credenciales Locales**: Para Spotify se usa PKCE puro sin secreto; para Google Web se envía el secreto localmente desde tu navegador al proxy sin intermediarios.
- **Protección DOM XSS & CSP**: Validación estricta de esquemas de URL, escape de entidades HTML y cabeceras estrictas de Content Security Policy (CSP).

---

## 📁 Estructura del Proyecto

| Archivo / Carpeta | Descripción |
| --- | --- |
| `server.js` | Servidor HTTP nativo Node.js, gestor de archivos estáticos y proxies OAuth seguros para Spotify y Google |
| `public/app.js` | Lógica de cliente: PKCE, llamadas a las APIs de Spotify y YouTube, limpieza de títulos y motor de transferencia |
| `public/index.html` | Interfaz interactiva SPA con selector de ruta en 4 pasos y consola en vivo |
| `public/style.css` | Estilos de scrollbar y animaciones de interfaz |
| `iniciar.bat`, `start.bat` | Lanzadores automáticos para Windows |

---

## 📄 Licencia

Código abierto bajo licencia MIT. Para uso personal y educativo.
