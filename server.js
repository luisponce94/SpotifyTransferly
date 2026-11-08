/**
 * ====================================================================
 * SpotifyTransferly - Servidor HTTP Local y Proxy OAuth PKCE
 * ====================================================================
 * Propósito:
 * 1. Servir los archivos estáticos de la aplicación web (HTML, JS, CSS).
 * 2. Actuar como proxy seguro para el intercambio de tokens OAuth (/api/token)
 *    hacia Spotify Accounts API, evitando restricciones de CORS del navegador.
 * 3. Proteger el origen local mediante validación estricta de Host/Origin,
 *    mitigando ataques de DNS Rebinding y Clickjacking.
 * ====================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const rawPort = process.env.PORT || '3000';
const parsedPort = parseInt(rawPort, 10);
if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    console.error(`[Error] Puerto inválido especificado: ${rawPort}`);
    process.exit(1);
}
const PORT = parsedPort;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Carga opcional de configuración local desde config.json o variables de entorno
let localConfig = {};
const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
    try {
        const rawConfig = fs.readFileSync(configPath, 'utf8');
        localConfig = JSON.parse(rawConfig);
        console.log('[Config] Configuración local cargada desde config.json.');
    } catch (e) {
        console.warn('[Config] Error al leer config.json:', e.message);
    }
}

function getAppConfig() {
    return {
        spotifyClientId: process.env.SPOTIFY_CLIENT_ID || localConfig.spotifyClientId || localConfig.spot_client_id || '',
        googleClientId: process.env.GOOGLE_CLIENT_ID || localConfig.googleClientId || localConfig.google_client_id || '',
        googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || localConfig.googleClientSecret || localConfig.google_client_secret || '',
        deezerAppId: process.env.DEEZER_APP_ID || localConfig.deezerAppId || localConfig.deezer_app_id || '',
        deezerSecret: process.env.DEEZER_SECRET || localConfig.deezerSecret || localConfig.deezer_secret || ''
    };
}

const MIME_TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'application/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.json': 'application/json; charset=UTF-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
    const hostHeader = req.headers.host || '';
    const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
    // Solo el navegador local puede acceder al proxy; evita DNS rebinding y CORS abierto.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: https://*.googleusercontent.com https://*.ytimg.com https://*.deezer.com https://*.dzcdn.net; connect-src 'self' https://api.spotify.com https://accounts.spotify.com https://www.googleapis.com https://oauth2.googleapis.com https://accounts.google.com https://connect.deezer.com https://api.deezer.com;");
    if (!allowedHosts.includes(hostHeader) ||
        (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`))) {
        res.writeHead(403);
        res.end('403 Prohibido');
        return;
    }

    // Enforce 127.0.0.1 instead of localhost to share origin storage with redirect_uri
    if (hostHeader.startsWith('localhost')) {
        res.writeHead(302, { 'Location': `http://127.0.0.1:${PORT}${req.url}` });
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let pathname = parsedUrl.pathname;

    // Handle OPTIONS for CORS
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
    }

    // Endpoint para consultar configuración inicial/preconfigurada
    if (pathname === '/api/config' && req.method === 'GET') {
        const cfg = getAppConfig();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({
            spotifyClientId: cfg.spotifyClientId,
            googleClientId: cfg.googleClientId,
            hasGoogleSecret: Boolean(cfg.googleClientSecret),
            deezerAppId: cfg.deezerAppId,
            hasDeezerSecret: Boolean(cfg.deezerSecret)
        }));
        return;
    }

    // Backend Proxy for Spotify Token Exchange
    if (pathname === '/api/token' && req.method === 'POST') {
        let body = '';
        let destroyed = false;

        req.on('error', (err) => {
            console.warn('[Spotify Proxy Stream Error]:', err.message);
            if (!res.headersSent) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bad Request', details: err.message }));
            }
        });

        req.on('data', chunk => {
            if (destroyed) return;
            body += chunk;
            if (body.length > 16384) {
                destroyed = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Payload Too Large' }));
                req.destroy();
            }
        });

        req.on('end', async () => {
            if (destroyed) return;
            try {
                // Saneamiento de parámetros x-www-form-urlencoded
                const searchParams = new URLSearchParams(body);
                const cfg = getAppConfig();
                if (!searchParams.get('client_id') && cfg.spotifyClientId) {
                    searchParams.set('client_id', cfg.spotifyClientId);
                }
                const parsedBody = searchParams.toString();
                if (!parsedBody) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'invalid_request', error_description: 'Cuerpo de petición vacío o malformado' }));
                    return;
                }

                console.log('[Token Proxy] Intercambiando código con Spotify...');
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                const spotifyRes = await fetch('https://accounts.spotify.com/api/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: parsedBody,
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                const data = await spotifyRes.text();
                // Nunca registrar el cuerpo: contiene access_token y refresh_token.
                console.log(`[Token Proxy] Respuesta Spotify (HTTP ${spotifyRes.status})`);

                res.writeHead(spotifyRes.status, {
                    'Content-Type': 'application/json',
                });
                res.end(data);
            } catch (err) {
                console.error('[Token Proxy Error]:', err);
                if (!res.headersSent) {
                    res.writeHead(502, {
                        'Content-Type': 'application/json',
                    });
                    res.end(JSON.stringify({ error: 'Proxy request failed', details: err.message }));
                }
            }
        });
        return;
    }

    // Backend Proxy for Google / YouTube Token Exchange
    if (pathname === '/api/youtube/token' && req.method === 'POST') {
        let body = '';
        let destroyed = false;

        req.on('error', (err) => {
            console.warn('[YouTube Proxy Stream Error]:', err.message);
            if (!res.headersSent) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bad Request', details: err.message }));
            }
        });

        req.on('data', chunk => {
            if (destroyed) return;
            body += chunk;
            if (body.length > 16384) {
                destroyed = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Payload Too Large' }));
                req.destroy();
            }
        });

        req.on('end', async () => {
            if (destroyed) return;
            try {
                // Saneamiento de parámetros x-www-form-urlencoded
                const searchParams = new URLSearchParams(body);
                const cfg = getAppConfig();
                if (!searchParams.get('client_id') && cfg.googleClientId) {
                    searchParams.set('client_id', cfg.googleClientId);
                }
                if (!searchParams.get('client_secret') && cfg.googleClientSecret) {
                    searchParams.set('client_secret', cfg.googleClientSecret);
                }
                const parsedBody = searchParams.toString();
                if (!parsedBody) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'invalid_request', error_description: 'Cuerpo de petición vacío o malformado' }));
                    return;
                }

                console.log('[YouTube Token Proxy] Intercambiando código con Google...');
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                const googleRes = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: parsedBody,
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                const data = await googleRes.text();
                console.log(`[YouTube Token Proxy] Respuesta Google (HTTP ${googleRes.status})`);

                res.writeHead(googleRes.status, {
                    'Content-Type': 'application/json',
                });
                res.end(data);
            } catch (err) {
                console.error('[YouTube Token Proxy Error]:', err);
                if (!res.headersSent) {
                    res.writeHead(502, {
                        'Content-Type': 'application/json',
                    });
                    res.end(JSON.stringify({ error: 'Proxy request failed', details: err.message }));
                }
            }
        });
        return;
    }

    // Backend Proxy for Deezer Token Exchange
    if (pathname === '/api/deezer/token' && req.method === 'POST') {
        let body = '';
        let destroyed = false;

        req.on('error', (err) => {
            console.warn('[Deezer Proxy Stream Error]:', err.message);
            if (!res.headersSent) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bad Request', details: err.message }));
            }
        });

        req.on('data', chunk => {
            if (destroyed) return;
            body += chunk;
            if (body.length > 16384) {
                destroyed = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Payload Too Large' }));
                req.destroy();
            }
        });

        req.on('end', async () => {
            if (destroyed) return;
            try {
                const params = new URLSearchParams(body);
                const cfg = getAppConfig();
                const appId = params.get('app_id') || cfg.deezerAppId;
                const secret = params.get('secret') || cfg.deezerSecret;
                const code = params.get('code');

                if (!appId || !secret || !code) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'invalid_request', error_description: 'Faltan parámetros requeridos (app_id, secret, code)' }));
                    return;
                }

                console.log('[Deezer Token Proxy] Intercambiando código con Deezer...');
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                const deezerTokenUrl = `https://connect.deezer.com/oauth/access_token.php?app_id=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}&code=${encodeURIComponent(code)}&output=json`;
                const deezerRes = await fetch(deezerTokenUrl, {
                    method: 'GET',
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                const rawText = await deezerRes.text();
                console.log(`[Deezer Token Proxy] Respuesta Deezer (HTTP ${deezerRes.status})`);

                let resultJson = {};
                try {
                    resultJson = JSON.parse(rawText);
                } catch (e) {
                    // Fallback si Deezer responde como query string (ej. access_token=...&expires=...)
                    const parsedQs = new URLSearchParams(rawText);
                    if (parsedQs.get('access_token')) {
                        resultJson = {
                            access_token: parsedQs.get('access_token'),
                            expires: parsedQs.get('expires')
                        };
                    } else {
                        resultJson = { error: rawText };
                    }
                }

                res.writeHead(deezerRes.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(resultJson));
            } catch (err) {
                console.error('[Deezer Token Proxy Error]:', err.message);
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Proxy request failed', details: err.message }));
                }
            }
        });
        return;
    }

    // Backend Proxy for Deezer REST API (para sortear restricciones de CORS de Deezer)
    if (pathname === '/api/deezer/proxy') {
        const targetPath = parsedUrl.searchParams.get('path') || '';

        // Validación estricta anti-SSRF y anti-bypass de host
        if (!targetPath.startsWith('/') || targetPath.startsWith('//') || targetPath.startsWith('/\\')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_path', error_description: 'Ruta no permitida' }));
            return;
        }

        let resolvedUrl;
        try {
            resolvedUrl = new URL(targetPath, 'https://api.deezer.com');
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'malformed_url' }));
            return;
        }

        if (resolvedUrl.origin !== 'https://api.deezer.com' || resolvedUrl.pathname.includes('/../')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_origin', error_description: 'Destino no autorizado' }));
            return;
        }

        let body = '';
        let destroyed = false;

        req.on('error', (err) => {
            console.warn('[Deezer API Proxy Stream Error]:', err.message);
            if (!res.headersSent) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bad Request', details: err.message }));
            }
        });

        req.on('data', chunk => {
            if (destroyed) return;
            body += chunk;
            if (body.length > 32768) {
                destroyed = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Payload Too Large' }));
                req.destroy();
            }
        });

        req.on('end', async () => {
            if (destroyed) return;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                const fetchOptions = {
                    method: req.method === 'POST' ? 'POST' : 'GET',
                    signal: controller.signal,
                    redirect: 'error'
                };

                if (req.method === 'POST' && body) {
                    fetchOptions.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
                    fetchOptions.body = body;
                }

                const apiRes = await fetch(resolvedUrl.href, fetchOptions);
                clearTimeout(timeoutId);

                const data = await apiRes.text();
                res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
                res.end(data);
            } catch (err) {
                console.error('[Deezer API Proxy Error]:', err.message);
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Deezer API proxy request failed', details: err.message }));
                }
            }
        });
        return;
    }

    // Validación de método HTTP para archivos estáticos
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=UTF-8' });
        res.end('405 Método no permitido');
        return;
    }

    // Default to index.html for root or SPA callback
    if (pathname === '/' || pathname === '/callback') {
        pathname = '/index.html';
    }

    const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);

    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('403 Prohibido');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            const hasExtension = path.extname(pathname) !== '';
            const acceptsHtml = (req.headers.accept || '').includes('text/html');

            if (!hasExtension && acceptsHtml) {
                const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
                fs.readFile(fallbackPath, (fallbackErr, content) => {
                    if (fallbackErr) {
                        res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
                        res.end('404 No encontrado');
                    } else {
                        res.writeHead(200, {
                            'Content-Type': 'text/html; charset=UTF-8',
                            'Cache-Control': 'no-cache, no-store, must-revalidate'
                        });
                        res.end(content);
                    }
                });
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
                res.end('404 No encontrado');
            }
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        fs.readFile(filePath, (readErr, content) => {
            if (readErr) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('500 Error de servidor');
            } else {
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                });
                res.end(content);
            }
        });
    });
});

server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`\n======================================================`);
    console.log(`  🎵 SpotTransfer Local - Migrador de Playlists Spotify`);
    console.log(`  Servidor corriendo en: ${url}`);
    console.log(`======================================================\n`);
    console.log(`Abriendo navegador en ${url} ...\n`);

    if (process.platform === 'win32' && process.env.OPEN_BROWSER !== '0') {
        exec(`start "" "${url}"`);
    }
});
