const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
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
    res.setHeader('Cache-Control', 'no-store');
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
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 16384) req.destroy();
        });
        req.on('end', async () => {
            try {
                console.log('[Token Proxy] Intercambiando código con Spotify...');
                const spotifyRes = await fetch('https://accounts.spotify.com/api/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: body
                });
                const data = await spotifyRes.text();
                // Nunca registrar el cuerpo: contiene access_token y refresh_token.
                console.log(`[Token Proxy] Respuesta Spotify (HTTP ${spotifyRes.status})`);

                res.writeHead(spotifyRes.status, {
                    'Content-Type': 'application/json',
                });
                res.end(data);
            } catch (err) {
                console.error('[Token Proxy Error]:', err);
                res.writeHead(500, {
                    'Content-Type': 'application/json',
                });
                res.end(JSON.stringify({ error: 'Proxy failed', details: err.message }));
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
            const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
            fs.readFile(fallbackPath, (fallbackErr, content) => {
                if (fallbackErr) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('404 No encontrado');
                } else {
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=UTF-8',
                        'Cache-Control': 'no-cache, no-store, must-revalidate'
                    });
                    res.end(content);
                }
            });
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
