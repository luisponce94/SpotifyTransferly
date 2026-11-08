# MusicTransferly (SpotifyTransferly)

Aplicación local y de código abierto para transferir y migrar playlists y canciones de forma **universal y multidireccional** entre **Spotify**, **YouTube Music** y **Deezer** (así como entre dos cuentas de una misma plataforma). Desarrollada con JavaScript, HTML5 y Tailwind CSS, con un servidor HTTP ligero en Node.js sin dependencias externas (`zero dependencies`).

---

## 🚀 Capacidades y Rutas Soportadas

La aplicación soporta la matriz completa de transferencia entre cualquier origen y cualquier destino:

1. 🟢 **Spotify** ➔ 🔴 **YouTube Music** / 🟣 **Deezer** / 🟢 **Spotify**
2. 🔴 **YouTube Music** ➔ 🟢 **Spotify** / 🟣 **Deezer** / 🔴 **YouTube Music**
3. 🟣 **Deezer** ➔ 🟢 **Spotify** / 🔴 **YouTube Music** / 🟣 **Deezer**
4. 💾 **Respaldo y Restauración Offline en JSON**: Exporta todas tus playlists y canciones a un archivo `.json` para guardarlas en tu equipo o restaurarlas en cualquier plataforma sin requerir acceso simultáneo a la cuenta origen.

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

## ⚡ Modo 1-Click y Configuración Rápida (Zero-Friction)

A diferencia de servicios comerciales de suscripción (Soundiiz, TuneMyMusic) que almacenan tus cuentas en servidores de terceros, **MusicTransferly corre 100% en tu propia computadora**, garantizando máxima privacidad sin telemetría ni intermediarios.

Para ofrecer una experiencia instantánea y sin fricción:
1. **Flujo Directo**: La aplicación abre directamente en la selección de plataformas (🟢 Spotify, 🔴 YouTube Music, 🟣 Deezer). Solo eliges origen, destino y haces clic en **Continuar a Conectar Cuentas**.
2. **Archivo `config.json` (Opcional pero recomendado)**: Puedes copiar `config.example.json` a `config.json` e incluir tus credenciales. El servidor y la interfaz las cargarán automáticamente, permitiéndote conectar en 1 clic sin tener que escribir nada en el navegador:
   ```json
   {
     "spotifyClientId": "tu_spotify_client_id",
     "googleClientId": "tu_google_client_id.apps.googleusercontent.com",
     "googleClientSecret": "tu_google_secret",
     "deezerAppId": "tu_deezer_app_id",
     "deezerSecret": "tu_deezer_secret"
   }
   ```
3. **Configuración en Vivo en Navegador**: Si no usas `config.json`, la app te solicitará el Client ID únicamente la primera vez que intentes conectar a cada plataforma mediante una ventana emergente rápida, y lo recordará localmente.

---

## 🔑 Cómo Obtener tus Credenciales Gratuitas (1 única vez)

La aplicación utiliza el flujo estándar y seguro **OAuth 2.0 con PKCE** y proxies locales en `127.0.0.1`. Las claves solo se configuran una vez y son 100% gratuitas:

### 1. Para Spotify:
1. Accede a [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) e inicia sesión con tu cuenta de Spotify.
2. Haz clic en **Create app**, dale un nombre (ej. `MusicTransferly`) y selecciona **Web API**.
3. En **Redirect URIs**, ingresa exactamente: `http://127.0.0.1:3000/callback`
4. Guarda y copia tu **Client ID** (para pegarlo en `config.json` o en la app).
5. *(Modo Desarrollo)*: En **Settings > Users and Access**, agrega los correos de las cuentas de Spotify que utilizarás.

### 2. Para YouTube Music (Google Cloud):
1. Accede a [Google Cloud Console](https://console.cloud.google.com) y crea un proyecto gratuito.
2. En **APIs y servicios > Biblioteca**, busca **YouTube Data API v3** y actívala (**Habilitar**).
3. En **Pantalla de consentimiento de OAuth**, selecciona tipo *Externo* y agrega tu correo en *Usuarios de prueba*.
4. En **Credenciales > Crear credenciales > ID de cliente de OAuth**, selecciona tipo **Aplicación web**.
5. En **URIs de redireccionamiento autorizados**, añade exactamente: `http://127.0.0.1:3000/callback`
6. Guarda y copia el **ID de cliente** generado (termina en `.apps.googleusercontent.com`) y el **Secreto de cliente** (Client Secret).
7. *Nota sobre cuotas*: Google asigna 10,000 unidades de cuota gratuita diaria por proyecto. La app maneja automáticamente este límite pausando la transferencia sin pérdida de datos si la cuota del día se agota.

### 3. Para Deezer:
1. Accede a [Deezer Developer Portal](https://developers.deezer.com/myapps) e inicia sesión con tu cuenta.
2. Haz clic en **Crear una nueva aplicación** (Create a new application).
3. En **Nombre de la aplicación** pon `MusicTransferly`.
4. En **Dominio de la aplicación** pon `127.0.0.1` o `localhost`.
5. En **URL de redireccionamiento** pon `http://127.0.0.1:3000/callback`.
6. Guarda y copia el **ID de la aplicación** (App ID) y la **Clave secreta** (Secret Key) generados.

---

## 🔒 Privacidad y Seguridad Local

- **Zero External Server**: Todos los intercambios de credenciales ocurren entre tu navegador y los servidores oficiales de Spotify / Google / Deezer a través del proxy local en `127.0.0.1:3000`.
- **Aislamiento de Tokens en `sessionStorage`**: Los tokens de acceso y actualización (`refresh_token`) se guardan temporalmente en `sessionStorage`, lo que garantiza que se eliminan por completo al cerrar la pestaña o el navegador.
- **Flujo PKCE & Credenciales Locales**: Para Spotify se usa PKCE puro sin secreto; para Google Web y Deezer se gestionan localmente desde tu navegador al proxy sin intermediarios.
- **Protección DOM XSS & CSP**: Validación estricta de esquemas de URL, escape de entidades HTML y cabeceras estrictas de Content Security Policy (CSP).

---

## 📁 Estructura del Proyecto

| Archivo / Carpeta | Descripción |
| --- | --- |
| `server.js` | Servidor HTTP nativo Node.js, gestor de archivos estáticos y proxies OAuth seguros para Spotify, Google y Deezer |
| `public/app.js` | Lógica de cliente: PKCE, llamadas a las APIs de Spotify, YouTube y Deezer, limpieza de títulos y motor de transferencia |
| `public/index.html` | Interfaz interactiva SPA con selector multidireccional de plataformas y consola en vivo |
| `public/style.css` | Estilos de scrollbar y animaciones de interfaz |
| `iniciar.bat`, `start.bat` | Lanzadores automáticos para Windows |

---

## 📄 Licencia

Código abierto bajo licencia MIT. Para uso personal y educativo.
