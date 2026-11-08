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
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: https://*.googleusercontent.com https://*.ytimg.com; connect-src 'self' https://api.spotify.com https://accounts.spotify.com https://www.googleapis.com https://oauth2.googleapis.com https://accounts.google.com;");
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

    // Backend Proxy for Spotify Token Exchange
    if (pathname === '/api/token' && req.method === 'POST') {
        let body = '';
        let destroyed = false;

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
                const parsedBody = new URLSearchParams(body).toString();
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
                res.writeHead(502, {
                    'Content-Type': 'application/json',
                });
                res.end(JSON.stringify({ error: 'Proxy request failed', details: err.message }));
            }
        });
        return;
    }

    // Backend Proxy for Google / YouTube Token Exchange
    if (pathname === '/api/youtube/token' && req.method === 'POST') {
        let body = '';
        let destroyed = false;

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
                const parsedBody = new URLSearchParams(body).toString();
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
                res.writeHead(502, {
                    'Content-Type': 'application/json',
                });
                res.end(JSON.stringify({ error: 'Proxy request failed', details: err.message }));
            }
        });
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
