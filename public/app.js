/**
 * ====================================================================
 * MusicTransferly - Motor de Migración Bidireccional
 * Spotify ⇄ YouTube Music (y Spotify ➔ Spotify / YouTube ➔ YouTube)
 * ====================================================================
 * ¿CÓMO FUNCIONA LA TRANSFERENCIA EXACTAMENTE?
 * 
 * 1. AUTENTICACIÓN PKCE (OAuth 2.0 sin Client Secret):
 *    - Ambas plataformas (Spotify y Google/YouTube) son autorizadas mediante
 *      el estándar seguro Proof Key for Code Exchange (PKCE, RFC 7636).
 *    - Se genera un `code_verifier` criptográfico aleatorio y su hash SHA-256 (`code_challenge`).
 *    - Los tokens resultantes se almacenan exclusivamente en `sessionStorage` del navegador
 *      (se destruyen automáticamente al cerrar la pestaña), sin servidores externos.
 * 
 * 2. GESTIÓN MULTI-PLATAFORMA (4 Rutas Posibles):
 *    - 🟢 Spotify ➔ 🔴 YouTube Music: Lee URIs y metadatos, busca videos oficiales en YouTube
 *      y crea las playlists en YouTube Music.
 *    - 🔴 YouTube Music ➔ 🟢 Spotify: Lee listas de YouTube, normaliza y limpia los títulos
 *      (eliminando [Official Video], HD, etc.) y busca las canciones en Spotify por ISMN/título/artista.
 *    - 🟢 Spotify ➔ 🟢 Spotify: Clonado directo de playlists entre cuentas de Spotify.
 *    - 🔴 YouTube ➔ 🔴 YouTube: Clonado directo de playlists entre cuentas de Google/YouTube.
 * 
 * 3. CONTROL DE RENDIMIENTO Y LÍMITES DE API:
 *    - Manejo automático de HTTP 429 con `Retry-After`.
 *    - Renovación transparente de tokens expirados (HTTP 401) con `refresh_token`.
 *    - Lotes controlados y pausas para respetar las cuotas diarias de la YouTube Data API.
 * ====================================================================
 */

// Enforce 127.0.0.1 to maintain identical localStorage/sessionStorage across redirects
if (window.location.hostname === 'localhost') {
    window.location.replace(window.location.href.replace('localhost', '127.0.0.1'));
}

// Global State
const currentPort = window.location.port ? `:${window.location.port}` : '';
const state = {
    step: 1,
    transferMode: localStorage.getItem('transfer_mode') || 'spotify-to-yt',
    clientId: localStorage.getItem('spot_client_id') || '',
    googleClientId: localStorage.getItem('google_client_id') || '',
    redirectUri: `${window.location.protocol}//127.0.0.1${currentPort}/callback`,

    // Spotify Tokens & Profiles
    sourceToken: sessionStorage.getItem('spot_source_token') || '',
    sourceRefreshToken: sessionStorage.getItem('spot_source_refresh_token') || '',
    sourceProfile: JSON.parse(sessionStorage.getItem('spot_source_profile') || 'null'),
    destToken: sessionStorage.getItem('spot_dest_token') || '',
    destRefreshToken: sessionStorage.getItem('spot_dest_refresh_token') || '',
    destProfile: JSON.parse(sessionStorage.getItem('spot_dest_profile') || 'null'),

    // YouTube / Google Tokens & Profiles
    ytSourceToken: sessionStorage.getItem('yt_source_token') || '',
    ytSourceRefreshToken: sessionStorage.getItem('yt_source_refresh_token') || '',
    ytSourceProfile: JSON.parse(sessionStorage.getItem('yt_source_profile') || 'null'),
    ytDestToken: sessionStorage.getItem('yt_dest_token') || '',
    ytDestRefreshToken: sessionStorage.getItem('yt_dest_refresh_token') || '',
    ytDestProfile: JSON.parse(sessionStorage.getItem('yt_dest_profile') || 'null'),

    // Playlists & Transfer state
    playlists: JSON.parse(localStorage.getItem('spot_playlists') || '[]'),
    likedSongsTotal: parseInt(localStorage.getItem('spot_liked_total') || '0', 10),
    isTransferring: false
};

// Limpieza de seguridad: borrar cualquier token residual de localStorage antiguo
['spot_source_token', 'spot_dest_token', 'spot_source_refresh_token', 'spot_dest_refresh_token',
 'yt_source_token', 'yt_dest_token', 'yt_source_refresh_token', 'yt_dest_refresh_token'].forEach(k => localStorage.removeItem(k));

// Platform mapping helpers
function getSourcePlatform() {
    return state.transferMode.startsWith('yt') ? 'youtube' : 'spotify';
}

function getDestPlatform() {
    return state.transferMode.endsWith('yt') ? 'youtube' : 'spotify';
}

function getSourceToken() {
    return getSourcePlatform() === 'youtube' ? state.ytSourceToken : state.sourceToken;
}

function getDestToken() {
    return getDestPlatform() === 'youtube' ? state.ytDestToken : state.destToken;
}

function getSourceProfile() {
    return getSourcePlatform() === 'youtube' ? state.ytSourceProfile : state.sourceProfile;
}

function getDestProfile() {
    return getDestPlatform() === 'youtube' ? state.ytDestProfile : state.destProfile;
}

// Persistence helper for playlists
function savePlaylists() {
    try {
        localStorage.setItem('spot_playlists', JSON.stringify(state.playlists));
        localStorage.setItem('spot_liked_total', state.likedSongsTotal);
    } catch (e) {
        console.warn('Error guardando listas en localStorage:', e);
    }
}

function updateDestinationSummary() {
    const selected = state.playlists.filter(p => p.selected);
    const totalTracks = selected.reduce((sum, p) => sum + (p.tracksCount || 0), 0);
    const summaryPlaylists = document.getElementById('summary-playlists-count');
    const summaryTracks = document.getElementById('summary-tracks-count');
    if (summaryPlaylists) summaryPlaylists.textContent = selected.length;
    if (summaryTracks) summaryTracks.textContent = totalTracks;
}

// Check if error is 403 Forbidden
function isForbidden(err) {
    if (!err) return false;
    if (err.status === 403) return true;
    const msg = (err.message || '').toLowerCase();
    return msg.includes('403') || msg.includes('forbidden') || msg.includes('not registered') || msg.includes('quotaexceeded');
}

// Escapar texto externo antes de insertarlo en el DOM
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

// Helper: Sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// DOM Elements
const views = {
    step1: document.getElementById('view-step-1'),
    step2: document.getElementById('view-step-2'),
    step3: document.getElementById('view-step-3'),
    step4: document.getElementById('view-step-4'),
    step5: document.getElementById('view-step-5'),
};

const dots = {
    dot1: document.getElementById('step-dot-1'),
    dot2: document.getElementById('step-dot-2'),
    dot3: document.getElementById('step-dot-3'),
    dot4: document.getElementById('step-dot-4'),
};

const stepperLine = document.getElementById('stepper-line');

// ==========================================
// 1. PKCE Helper Functions
// ==========================================
function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let result = '';
    const randomValues = new Uint8Array(length);
    window.crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
        result += chars[randomValues[i] % chars.length];
    }
    return result;
}

async function sha256(plain) {
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    return window.crypto.subtle.digest('SHA-256', data);
}

function base64UrlEncode(buffer) {
    let str = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        str += String.fromCharCode(bytes[i]);
    }
    return btoa(str)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// ==========================================
// 2. OAuth PKCE Flow - Spotify & Google
// ==========================================

// Iniciar autorización Spotify (mode = 'source' | 'destination')
async function initiateSpotifyAuth(mode) {
    if (!state.clientId) {
        alert('Por favor configura primero tu Spotify Client ID.');
        setStep(1);
        return;
    }

    savePlaylists();

    const verifier = generateRandomString(64);
    const hashed = await sha256(verifier);
    const challenge = base64UrlEncode(hashed);

    const oauthState = `spotify_${mode}_${generateRandomString(24)}`;
    sessionStorage.setItem('oauth_expected_state', oauthState);
    sessionStorage.setItem('oauth_auth_mode', mode);
    sessionStorage.setItem('oauth_platform', 'spotify');
    sessionStorage.setItem('oauth_code_verifier', verifier);

    const scopes = [
        'playlist-read-private',
        'playlist-read-collaborative',
        'user-library-read',
        'playlist-modify-public',
        'playlist-modify-private',
        'user-library-modify',
        'user-read-private',
        'user-read-email'
    ].join(' ');

    const params = new URLSearchParams({
        state: oauthState,
        response_type: 'code',
        client_id: state.clientId,
        scope: scopes,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        redirect_uri: state.redirectUri,
        show_dialog: 'true'
    });

    window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

// Iniciar autorización Google / YouTube (mode = 'source' | 'destination')
async function initiateGoogleAuth(mode) {
    if (!state.googleClientId) {
        alert('Por favor configura primero tu Google / YouTube Client ID.');
        setStep(1);
        return;
    }

    savePlaylists();

    const verifier = generateRandomString(64);
    const hashed = await sha256(verifier);
    const challenge = base64UrlEncode(hashed);

    const oauthState = `google_${mode}_${generateRandomString(24)}`;
    sessionStorage.setItem('oauth_expected_state', oauthState);
    sessionStorage.setItem('oauth_auth_mode', mode);
    sessionStorage.setItem('oauth_platform', 'google');
    sessionStorage.setItem('oauth_code_verifier', verifier);

    const scopes = [
        'https://www.googleapis.com/auth/youtube',
        'https://www.googleapis.com/auth/userinfo.profile'
    ].join(' ');

    const params = new URLSearchParams({
        client_id: state.googleClientId,
        redirect_uri: state.redirectUri,
        response_type: 'code',
        scope: scopes,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: oauthState,
        access_type: 'offline',
        prompt: 'consent'
    });

    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Iniciar login dinámicamente según plataforma del paso actual
function initiateAuth(target) {
    const platform = (target === 'source') ? getSourcePlatform() : getDestPlatform();
    if (platform === 'youtube') {
        initiateGoogleAuth(target);
    } else {
        initiateSpotifyAuth(target);
    }
}

// Exchange Spotify authorization code
async function exchangeSpotifyCode(code, verifier) {
    const payload = new URLSearchParams({
        client_id: state.clientId,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: state.redirectUri,
        code_verifier: verifier
    });

    const res = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString()
    });

    return await res.json();
}

// Exchange Google authorization code
async function exchangeGoogleCode(code, verifier) {
    const payload = new URLSearchParams({
        client_id: state.googleClientId,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: state.redirectUri,
        code_verifier: verifier
    });

    const res = await fetch('/api/youtube/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString()
    });

    return await res.json();
}

// Renovar access_token de Spotify con refresh_token
async function refreshSpotifyToken(mode) {
    const refreshToken = (mode === 'source') ? state.sourceRefreshToken : state.destRefreshToken;
    if (!refreshToken) throw new Error(`No hay refresh token para Spotify (${mode}).`);

    const payload = new URLSearchParams({
        client_id: state.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    });

    const res = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString()
    });

    const tokenData = await res.json();
    if (tokenData.access_token) {
        if (mode === 'source') {
            state.sourceToken = tokenData.access_token;
            sessionStorage.setItem('spot_source_token', tokenData.access_token);
            if (tokenData.refresh_token) {
                state.sourceRefreshToken = tokenData.refresh_token;
                sessionStorage.setItem('spot_source_refresh_token', tokenData.refresh_token);
            }
        } else {
            state.destToken = tokenData.access_token;
            sessionStorage.setItem('spot_dest_token', tokenData.access_token);
            if (tokenData.refresh_token) {
                state.destRefreshToken = tokenData.refresh_token;
                sessionStorage.setItem('spot_dest_refresh_token', tokenData.refresh_token);
            }
        }
        return tokenData.access_token;
    }
    throw new Error(tokenData.error_description || tokenData.error || 'No se pudo renovar token de Spotify');
}

// Renovar access_token de Google con refresh_token
async function refreshGoogleToken(mode) {
    const refreshToken = (mode === 'source') ? state.ytSourceRefreshToken : state.ytDestRefreshToken;
    if (!refreshToken) throw new Error(`No hay refresh token para Google (${mode}).`);

    const payload = new URLSearchParams({
        client_id: state.googleClientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    });

    const res = await fetch('/api/youtube/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString()
    });

    const tokenData = await res.json();
    if (tokenData.access_token) {
        if (mode === 'source') {
            state.ytSourceToken = tokenData.access_token;
            sessionStorage.setItem('yt_source_token', tokenData.access_token);
        } else {
            state.ytDestToken = tokenData.access_token;
            sessionStorage.setItem('yt_dest_token', tokenData.access_token);
        }
        return tokenData.access_token;
    }
    throw new Error(tokenData.error_description || tokenData.error || 'No se pudo renovar token de Google');
}

// ==========================================
// 3. API Callers (Spotify & YouTube)
// ==========================================

// Authenticated Spotify API caller
async function spotifyApi(token, endpoint, options = {}) {
    const url = new URL(endpoint.startsWith('http') ? endpoint : `https://api.spotify.com/v1${endpoint}`);
    if (url.origin !== 'https://api.spotify.com') throw new Error('Destino de API no permitido.');

    const headers = {
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {})
    };
    if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    let attempts = 0;
    while (attempts < 5) {
        attempts++;
        try {
            const res = await fetch(url, { ...options, headers });

            if (res.status === 429) {
                const retryAfter = parseInt(res.headers.get('Retry-After') || '2', 10);
                logMessage(`[Aviso] Límite de Spotify alcanzado. Pausando ${retryAfter}s...`);
                await sleep((retryAfter + 1) * 1000);
                continue;
            }

            if (res.status === 204) return null;

            const text = await res.text();

            if (!res.ok) {
                let msg = `HTTP ${res.status}`;
                try {
                    const errData = JSON.parse(text);
                    msg = errData.error?.message || msg;
                } catch (e) {}
                const err = new Error(msg);
                err.status = res.status;
                err.statusText = res.statusText;

                // Auto-refresh token ante 401 si no se ha intentado ya
                if (res.status === 401 && !options._isRetryAfterRefresh) {
                    const mode = (token === state.sourceToken) ? 'source' : ((token === state.destToken) ? 'destination' : null);
                    if (mode) {
                        try {
                            logMessage(`[Sesión] Renovando token expirado de Spotify (${mode})...`);
                            const newToken = await refreshSpotifyToken(mode);
                            return await spotifyApi(newToken, endpoint, { ...options, _isRetryAfterRefresh: true });
                        } catch (refreshErr) {
                            console.warn('Error al auto-renovar token Spotify:', refreshErr);
                        }
                    }
                }

                if ([400, 401, 403, 404].includes(res.status)) {
                    throw err;
                }
                throw err;
            }

            if (!text || text.trim().length === 0) return null;

            try {
                return JSON.parse(text);
            } catch (e) {
                return text;
            }
        } catch (err) {
            if (err.status && [400, 401, 403, 404].includes(err.status)) throw err;
            if (attempts >= 5) throw err;
            await sleep(1000 * attempts);
        }
    }
}

// Authenticated YouTube Data API caller
async function youtubeApi(token, endpoint, options = {}) {
    const url = new URL(endpoint.startsWith('http') ? endpoint : `https://www.googleapis.com/youtube/v3${endpoint}`);
    if (url.origin !== 'https://www.googleapis.com' && url.origin !== 'https://oauth2.googleapis.com') {
        throw new Error('Destino de API no permitido.');
    }

    const headers = {
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {})
    };
    if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    let attempts = 0;
    while (attempts < 5) {
        attempts++;
        try {
            const res = await fetch(url, { ...options, headers });

            if (res.status === 429) {
                logMessage(`[Aviso] Cuota o límite de YouTube alcanzado. Pausando 3s...`);
                await sleep(3000);
                continue;
            }

            if (res.status === 204) return null;

            const text = await res.text();

            if (!res.ok) {
                let msg = `HTTP ${res.status}`;
                try {
                    const errData = JSON.parse(text);
                    msg = errData.error?.message || msg;
                } catch (e) {}
                const err = new Error(msg);
                err.status = res.status;
                err.statusText = res.statusText;

                // Auto-refresh token ante 401
                if (res.status === 401 && !options._isRetryAfterRefresh) {
                    const mode = (token === state.ytSourceToken) ? 'source' : ((token === state.ytDestToken) ? 'destination' : null);
                    if (mode) {
                        try {
                            logMessage(`[Sesión] Renovando token expirado de YouTube (${mode})...`);
                            const newToken = await refreshGoogleToken(mode);
                            return await youtubeApi(newToken, endpoint, { ...options, _isRetryAfterRefresh: true });
                        } catch (refreshErr) {
                            console.warn('Error al auto-renovar token Google:', refreshErr);
                        }
                    }
                }

                if ([400, 401, 403, 404].includes(res.status)) throw err;
                throw err;
            }

            if (!text || text.trim().length === 0) return null;

            try {
                return JSON.parse(text);
            } catch (e) {
                return text;
            }
        } catch (err) {
            if (err.status && [400, 401, 403, 404].includes(err.status)) throw err;
            if (attempts >= 5) throw err;
            await sleep(1000 * attempts);
        }
    }
}

// ==========================================
// 4. YouTube Helper Functions
// ==========================================

// Cargar perfil de Google del usuario
async function loadGoogleProfile(token) {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} al cargar perfil de Google`);
    return await res.json();
}

// Cargar listas del usuario de YouTube
async function loadYouTubePlaylists(token) {
    let playlists = [];
    let pageToken = '';

    while (true) {
        const url = `/playlists?part=snippet,contentDetails&mine=true&maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const data = await youtubeApi(token, url);

        if (data && data.items) {
            playlists = playlists.concat(data.items);
            pageToken = data.nextPageToken || '';
            if (!pageToken) break;
        } else {
            break;
        }
    }
    return playlists;
}

// Obtener canciones de una playlist de YouTube
async function fetchYouTubePlaylistTracks(token, playlistId) {
    let tracks = [];
    let pageToken = '';

    while (true) {
        const url = `/playlistItems?part=snippet&playlistId=${encodeURIComponent(playlistId)}&maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const data = await youtubeApi(token, url);

        if (data && data.items) {
            data.items.forEach(item => {
                const snip = item.snippet;
                const videoId = snip?.resourceId?.videoId;
                if (videoId && snip.title && snip.title !== 'Private video' && snip.title !== 'Deleted video') {
                    tracks.push({
                        id: videoId,
                        videoId: videoId,
                        name: snip.title,
                        artist: snip.videoOwnerChannelTitle || ''
                    });
                }
            });
            pageToken = data.nextPageToken || '';
            if (!pageToken) break;
        } else {
            break;
        }
    }
    return tracks;
}

// Crear playlist en YouTube
async function createYouTubePlaylist(token, title, description, isPrivate) {
    const body = {
        snippet: {
            title: title,
            description: description || 'Migrada con MusicTransferly'
        },
        status: {
            privacyStatus: isPrivate ? 'private' : 'public'
        }
    };

    return await youtubeApi(token, '/playlists?part=snippet,status', {
        method: 'POST',
        body: JSON.stringify(body)
    });
}

// Añadir video a una playlist de YouTube
async function addVideoToYouTubePlaylist(token, playlistId, videoId) {
    const body = {
        snippet: {
            playlistId: playlistId,
            resourceId: {
                kind: 'youtube#video',
                videoId: videoId
            }
        }
    };

    return await youtubeApi(token, '/playlistItems?part=snippet', {
        method: 'POST',
        body: JSON.stringify(body)
    });
}

// Buscar video en YouTube correspondiente a una canción (con Music category)
async function searchYouTubeVideo(token, title, artist) {
    const cleanT = cleanTitleForSearch(title);
    const query = artist ? `${artist} - ${cleanT}` : cleanT;
    const url = `/search?part=snippet&type=video&videoCategoryId=10&maxResults=1&q=${encodeURIComponent(query)}`;

    try {
        const res = await youtubeApi(token, url);
        if (res?.items?.[0]?.id?.videoId) {
            return res.items[0].id.videoId;
        }
    } catch (e) {
        console.warn('Error en búsqueda de YouTube:', e);
    }

    // Fallback general sin categoría si la de música no encontró resultado
    try {
        const fallbackUrl = `/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query + ' audio')}`;
        const res2 = await youtubeApi(token, fallbackUrl);
        return res2?.items?.[0]?.id?.videoId || null;
    } catch (e2) {
        return null;
    }
}

// ==========================================
// 5. Algoritmo de Normalización y Limpieza de Títulos
// ==========================================

// Limpia sufijos ruidosos de videos de YouTube para búsqueda exacta en Spotify
function cleanYouTubeTitle(rawTitle) {
    if (!rawTitle) return { title: '', artist: '' };

    let str = rawTitle;

    // Eliminar etiquetas tipo [Official Video], (Audio Oficial), etc.
    str = str.replace(/\[(official|video|audio|lyrics?|hd|4k|remastered|visualizer|clip|letra).*?\]/gi, '');
    str = str.replace(/\((official|video|audio|lyrics?|hd|4k|remastered|visualizer|clip|letra|version|en vivo).*?\)/gi, '');
    str = str.replace(/\|\s*official\s*(music\s*)?video/gi, '');
    str = str.replace(/ft\.\s*[^()\[\]-]+/gi, '');
    str = str.replace(/feat\.\s*[^()\[\]-]+/gi, '');
    str = str.replace(/\s+/g, ' ').trim();

    // Intentar separar "Artista - Título" si existe guión o guión largo
    const dashMatch = str.match(/^(.*?)\s*[-–—:]\s*(.*)$/);
    if (dashMatch) {
        return {
            artist: dashMatch[1].trim(),
            title: dashMatch[2].trim()
        };
    }

    return { title: str, artist: '' };
}

function cleanTitleForSearch(title) {
    return (title || '')
        .replace(/[\(\[\{].*?[\)\]\}]/g, '')
        .replace(/[^\w\s\u00C0-\u017F]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Buscar canción en Spotify usando título y artista
async function searchSpotifyTrack(token, rawTitle, defaultArtist = '') {
    const parsed = cleanYouTubeTitle(rawTitle);
    const title = parsed.title || rawTitle;
    const artist = parsed.artist || defaultArtist;

    // 1. Intento estricto con campos track y artist
    if (artist && title) {
        try {
            const q = `track:${encodeURIComponent(title)} artist:${encodeURIComponent(artist)}`;
            const res = await spotifyApi(token, `/search?type=track&limit=1&q=${q}`);
            if (res?.tracks?.items?.[0]?.uri) return res.tracks.items[0].uri;
        } catch (e) {}
    }

    // 2. Intento de texto libre con artista y título
    try {
        const freeQuery = encodeURIComponent(`${title} ${artist}`.trim());
        const res2 = await spotifyApi(token, `/search?type=track&limit=1&q=${freeQuery}`);
        if (res2?.tracks?.items?.[0]?.uri) return res2.tracks.items[0].uri;
    } catch (e) {}

    // 3. Intento únicamente con título limpio
    try {
        const cleanT = cleanTitleForSearch(title);
        const res3 = await spotifyApi(token, `/search?type=track&limit=1&q=${encodeURIComponent(cleanT)}`);
        return res3?.tracks?.items?.[0]?.uri || null;
    } catch (e) {
        return null;
    }
}

// ==========================================
// 6. Navigation & Stepper
// ==========================================
function setStep(stepNumber) {
    state.step = stepNumber;
    localStorage.setItem('spot_step', stepNumber);

    Object.values(views).forEach(v => v.classList.add('hidden'));

    if (views[`step${stepNumber}`]) {
        views[`step${stepNumber}`].classList.remove('hidden');
    }

    if (stepNumber === 2) {
        updateStep2UI();
    } else if (stepNumber === 3) {
        updateStep3UI();
        updateDestinationSummary();
    }

    const percent = ((stepNumber - 1) / 3) * 100;
    stepperLine.style.width = `${percent}%`;

    [1, 2, 3, 4].forEach(n => {
        const dot = dots[`dot${n}`];
        if (n < stepNumber) {
            dot.className = 'w-10 h-10 rounded-full bg-spotify-green text-black font-bold flex items-center justify-center text-sm shadow-md transition-all';
            dot.innerHTML = '✓';
        } else if (n === stepNumber) {
            dot.className = 'w-10 h-10 rounded-full bg-spotify-green text-black font-bold flex items-center justify-center text-sm shadow-lg ring-4 ring-spotify-green/20 transition-all';
            dot.innerHTML = `${n}`;
        } else {
            dot.className = 'w-10 h-10 rounded-full bg-spotify-card border-2 border-spotify-border text-gray-400 font-bold flex items-center justify-center text-sm transition-all';
            dot.innerHTML = `${n}`;
        }
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Adaptación dinámica de UI según el modo seleccionado
function updateModeUI() {
    const srcPlat = getSourcePlatform();
    const dstPlat = getDestPlatform();

    // Actualizar tarjetas de selección de ruta
    document.querySelectorAll('#transfer-mode-selector .route-card').forEach(card => {
        const mode = card.getAttribute('data-mode');
        const check = card.querySelector('.route-check');
        if (mode === state.transferMode) {
            card.className = 'route-card p-4 rounded-xl border-2 border-spotify-green bg-spotify-dark/80 text-left transition flex items-center justify-between';
            if (check) check.classList.remove('hidden');
        } else {
            card.className = 'route-card p-4 rounded-xl border border-spotify-border bg-spotify-card/50 text-left transition flex items-center justify-between opacity-70 hover:opacity-100';
            if (check) check.classList.add('hidden');
        }
    });

    // Mostrar/ocultar inputs y guías según las plataformas requeridas
    const needsSpotify = srcPlat === 'spotify' || dstPlat === 'spotify';
    const needsGoogle = srcPlat === 'youtube' || dstPlat === 'youtube';

    const fieldSpotify = document.getElementById('field-spotify-client-id');
    const fieldGoogle = document.getElementById('field-google-client-id');
    const guideSpotify = document.getElementById('guide-spotify');
    const guideYoutube = document.getElementById('guide-youtube');

    if (fieldSpotify) fieldSpotify.style.display = needsSpotify ? 'block' : 'none';
    if (fieldGoogle) fieldGoogle.style.display = needsGoogle ? 'block' : 'none';
    if (guideSpotify) guideSpotify.style.display = needsSpotify ? 'block' : 'none';
    if (guideYoutube) guideYoutube.style.display = needsGoogle ? 'block' : 'none';

    // Etiquetas del Stepper
    const stepLabel2 = document.getElementById('step-label-2');
    const stepLabel3 = document.getElementById('step-label-3');
    if (stepLabel2) stepLabel2.textContent = srcPlat === 'youtube' ? 'Origen (YouTube)' : 'Origen (Spotify)';
    if (stepLabel3) stepLabel3.textContent = dstPlat === 'youtube' ? 'Destino (YouTube)' : 'Destino (Spotify)';
}

function updateStep2UI() {
    const srcPlat = getSourcePlatform();
    const badge = document.getElementById('source-platform-badge');
    const btnLogin = document.getElementById('btn-login-source');
    const profile = getSourceProfile();
    const token = getSourceToken();

    if (srcPlat === 'youtube') {
        if (badge) {
            badge.textContent = 'Cuenta de Origen: YouTube Music';
            badge.className = 'text-xs uppercase tracking-wider text-red-500 font-semibold';
        }
        if (btnLogin) {
            btnLogin.className = 'bg-red-600 hover:bg-red-500 text-white font-bold px-6 py-3 rounded-full transition flex items-center gap-2 shadow-lg shadow-red-600/20';
            btnLogin.textContent = token ? 'Cambiar cuenta de Google/YouTube' : 'Conectar Google / YouTube Origen';
        }
    } else {
        if (badge) {
            badge.textContent = 'Cuenta de Origen: Spotify';
            badge.className = 'text-xs uppercase tracking-wider text-spotify-green font-semibold';
        }
        if (btnLogin) {
            btnLogin.className = 'bg-spotify-green hover:bg-spotify-hover text-black font-bold px-6 py-3 rounded-full transition flex items-center gap-2 shadow-lg shadow-spotify-green/20';
            btnLogin.textContent = token ? 'Cambiar cuenta de Spotify' : 'Conectar Cuenta de Spotify';
        }
    }

    if (profile) {
        document.getElementById('source-name').textContent = profile.display_name || profile.name || profile.id;
        document.getElementById('source-email').textContent = profile.email || `ID: ${profile.id}`;
        const pic = profile.picture || profile.images?.[0]?.url;
        if (pic) {
            document.getElementById('source-avatar').innerHTML = `<img src="${escapeHtml(pic)}" class="w-full h-full object-cover rounded-full" alt="avatar">`;
        }
    }
}

function updateStep3UI() {
    const dstPlat = getDestPlatform();
    const badge = document.getElementById('dest-platform-badge');
    const btnLogin = document.getElementById('dest-auth-card')?.querySelector('#btn-login-dest');
    const heartBox = document.getElementById('opt-heart-songs-box');
    const profile = getDestProfile();
    const token = getDestToken();

    if (dstPlat === 'youtube') {
        if (badge) {
            badge.textContent = 'Cuenta de Destino: YouTube Music';
            badge.className = 'text-xs uppercase tracking-wider text-red-500 font-semibold';
        }
        if (btnLogin) {
            btnLogin.className = 'bg-red-600 hover:bg-red-500 text-white font-bold px-6 py-3 rounded-full transition flex items-center gap-2 shadow-lg shadow-red-600/20';
            btnLogin.textContent = token ? 'Cambiar cuenta YouTube destino' : 'Conectar YouTube Destino';
        }
        if (heartBox) heartBox.style.display = 'none';
    } else {
        if (badge) {
            badge.textContent = 'Cuenta de Destino: Spotify';
            badge.className = 'text-xs uppercase tracking-wider text-blue-400 font-semibold';
        }
        if (btnLogin) {
            btnLogin.className = 'bg-blue-500 hover:bg-blue-400 text-white font-bold px-6 py-3 rounded-full transition flex items-center gap-2 shadow-lg shadow-blue-500/20';
            btnLogin.textContent = token ? 'Cambiar cuenta Spotify destino' : 'Conectar Spotify Destino';
        }
        if (heartBox) heartBox.style.display = 'flex';
    }

    if (profile) {
        document.getElementById('dest-name').textContent = profile.display_name || profile.name || profile.id;
        document.getElementById('dest-email').textContent = profile.email || `ID: ${profile.id}`;
        const pic = profile.picture || profile.images?.[0]?.url;
        if (pic) {
            document.getElementById('dest-avatar').innerHTML = `<img src="${escapeHtml(pic)}" class="w-full h-full object-cover rounded-full" alt="avatar">`;
        }
    }
}

// ==========================================
// 7. Step 1: Configuration Logic
// ==========================================
document.getElementById('redirect-uri-display').textContent = state.redirectUri;

document.getElementById('btn-copy-uri').addEventListener('click', () => {
    navigator.clipboard.writeText(state.redirectUri);
    const btn = document.getElementById('btn-copy-uri');
    const oldText = btn.textContent;
    btn.textContent = '¡Copiado!';
    setTimeout(() => { btn.textContent = oldText; }, 2000);
});

// Selector de ruta
document.querySelectorAll('#transfer-mode-selector .route-card').forEach(btn => {
    btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode');
        state.transferMode = mode;
        localStorage.setItem('transfer_mode', mode);
        updateModeUI();
    });
});

if (state.clientId) {
    document.getElementById('input-client-id').value = state.clientId;
}
if (state.googleClientId) {
    document.getElementById('input-google-client-id').value = state.googleClientId;
}
updateModeUI();

document.getElementById('form-config').addEventListener('submit', (e) => {
    e.preventDefault();
    const srcPlat = getSourcePlatform();
    const dstPlat = getDestPlatform();

    const spotId = document.getElementById('input-client-id').value.trim();
    const googleId = document.getElementById('input-google-client-id').value.trim();

    if ((srcPlat === 'spotify' || dstPlat === 'spotify') && !spotId) {
        alert('Por favor ingresa tu Spotify Client ID.');
        return;
    }
    if ((srcPlat === 'youtube' || dstPlat === 'youtube') && !googleId) {
        alert('Por favor ingresa tu Google / YouTube Client ID.');
        return;
    }

    if (spotId) {
        state.clientId = spotId;
        localStorage.setItem('spot_client_id', spotId);
    }
    if (googleId) {
        state.googleClientId = googleId;
        localStorage.setItem('google_client_id', googleId);
    }

    setStep(2);
});

// ==========================================
// 8. Step 2: Source Account Logic
// ==========================================
document.getElementById('btn-login-source').addEventListener('click', () => {
    const banner403 = document.getElementById('source-403-banner');
    if (banner403) banner403.classList.add('hidden');
    initiateAuth('source');
});

async function loadSourceProfileAndPlaylists() {
    const srcPlat = getSourcePlatform();
    const token = getSourceToken();
    if (!token) return;

    const sourceBtn = document.getElementById('btn-login-source');
    sourceBtn.innerHTML = `⏳ Cargando datos...`;

    try {
        if (srcPlat === 'youtube') {
            // YouTube Flow
            const profile = await loadGoogleProfile(token);
            state.ytSourceProfile = profile;
            sessionStorage.setItem('yt_source_profile', JSON.stringify(profile));

            document.getElementById('source-name').textContent = profile.name || profile.email;
            document.getElementById('source-email').textContent = profile.email || `ID: ${profile.id}`;
            if (profile.picture) {
                document.getElementById('source-avatar').innerHTML = `<img src="${escapeHtml(profile.picture)}" class="w-full h-full object-cover rounded-full" alt="avatar">`;
            }
            sourceBtn.innerHTML = 'Cambiar cuenta YouTube origen';
            document.getElementById('source-content').classList.remove('hidden');

            const ytPlaylists = await loadYouTubePlaylists(token);
            state.playlists = ytPlaylists.map(pl => ({
                id: pl.id,
                name: pl.snippet?.title || 'Sin título',
                description: pl.snippet?.description || '',
                tracksCount: pl.contentDetails?.itemCount || 0,
                imageUrl: pl.snippet?.thumbnails?.medium?.url || pl.snippet?.thumbnails?.default?.url || '',
                platform: 'youtube',
                isLikedSongs: false,
                isOwned: true,
                selected: true,
                tracks: []
            }));

        } else {
            // Spotify Flow
            const profile = await spotifyApi(token, '/me');
            state.sourceProfile = profile;
            sessionStorage.setItem('spot_source_profile', JSON.stringify(profile));

            document.getElementById('source-name').textContent = profile.display_name || profile.id;
            document.getElementById('source-email').textContent = profile.email || `ID: ${profile.id}`;
            if (profile.images && profile.images.length > 0) {
                document.getElementById('source-avatar').innerHTML = `<img src="${escapeHtml(profile.images[0].url)}" class="w-full h-full object-cover rounded-full" alt="avatar">`;
            }
            sourceBtn.innerHTML = 'Cambiar cuenta Spotify origen';
            document.getElementById('source-content').classList.remove('hidden');

            // Liked songs count
            let likedCount = 0;
            try {
                const likedRes = await spotifyApi(token, '/me/tracks?limit=1');
                likedCount = likedRes.total || 0;
            } catch (e) {
                console.warn('No se pudieron obtener me gusta:', e);
            }
            state.likedSongsTotal = likedCount;

            // Fetch playlists
            let playlists = [];
            let url = '/me/playlists?limit=50';
            while (url) {
                const data = await spotifyApi(token, url);
                if (data && data.items) {
                    playlists = playlists.concat(data.items);
                    url = data.next;
                } else {
                    break;
                }
            }

            state.playlists = [];

            if (state.likedSongsTotal > 0) {
                state.playlists.push({
                    id: '__LIKED_SONGS__',
                    name: '❤️ Canciones que te gustan (Liked Songs)',
                    description: 'Tus canciones favoritas guardadas en tu biblioteca',
                    tracksCount: state.likedSongsTotal,
                    imageUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%231ed760"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
                    platform: 'spotify',
                    isLikedSongs: true,
                    isOwned: true,
                    selected: true,
                    tracks: []
                });
            }

            playlists.forEach(pl => {
                if (!pl) return;
                const isOwned = pl.owner?.id === profile.id;
                state.playlists.push({
                    id: pl.id,
                    name: pl.name,
                    description: pl.description || '',
                    tracksCount: pl.tracks?.total || 0,
                    imageUrl: pl.images?.[0]?.url || '',
                    platform: 'spotify',
                    isLikedSongs: false,
                    isOwned: isOwned,
                    selected: true,
                    tracks: []
                });
            });
        }

        savePlaylists();
        renderPlaylists();
    } catch (err) {
        console.error('Error cargando origen:', err);
        sourceBtn.innerHTML = srcPlat === 'youtube' ? 'Conectar YouTube Origen' : 'Conectar Spotify Origen';

        if (isForbidden(err)) {
            const banner403 = document.getElementById('source-403-banner');
            if (banner403 && srcPlat === 'spotify') {
                banner403.classList.remove('hidden');
                banner403.scrollIntoView({ behavior: 'smooth' });
            } else {
                alert('Error 403: Verifica los permisos o cuota de API de tu cuenta.');
            }
        } else if (err.message && (err.message.includes('401') || err.message.includes('expired'))) {
            alert('Tu sesión expiró. Por favor vuelve a hacer clic en Conectar.');
        } else {
            alert('Error al conectar con la cuenta de origen: ' + err.message);
        }
    }
}

function renderPlaylists() {
    const grid = document.getElementById('playlists-grid');
    const filter = (document.getElementById('input-search-playlists').value || '').toLowerCase();
    grid.innerHTML = '';

    const filtered = state.playlists.filter(p => p.name.toLowerCase().includes(filter));

    if (filtered.length === 0) {
        grid.innerHTML = `<div class="col-span-full py-8 text-center text-gray-500 text-sm">No se encontraron listas.</div>`;
        updateSelectionCounter();
        return;
    }

    filtered.forEach(p => {
        const card = document.createElement('div');
        card.className = `p-3 rounded-xl border transition cursor-pointer flex items-center gap-3 ${
            p.selected
                ? 'bg-spotify-card border-spotify-green/50 hover:border-spotify-green'
                : 'bg-spotify-card/40 border-spotify-border hover:border-gray-600 opacity-60'
        }`;

        const imgHtml = p.imageUrl
            ? `<img src="${escapeHtml(p.imageUrl)}" class="w-12 h-12 rounded-lg object-cover flex-shrink-0 bg-spotify-dark" alt="cover">`
            : `<div class="w-12 h-12 rounded-lg bg-spotify-dark flex items-center justify-center flex-shrink-0 text-gray-500">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"></path></svg>
               </div>`;

        const badgeHtml = !p.isOwned && !p.isLikedSongs
            ? `<span class="text-[10px] bg-blue-500/20 text-blue-400 border border-blue-500/30 px-1.5 py-0.5 rounded ml-1.5 font-normal">Pública</span>`
            : '';

        card.innerHTML = `
            <input type="checkbox" ${p.selected ? 'checked' : ''} class="w-4 h-4 accent-spotify-green rounded pointer-events-none">
            ${imgHtml}
            <div class="flex-1 min-w-0">
                <h4 class="text-sm font-semibold text-white truncate flex items-center">${escapeHtml(p.name)} ${badgeHtml}</h4>
                <p class="text-xs text-gray-400 mt-0.5">${p.tracksCount} canciones</p>
            </div>
        `;

        card.setAttribute('role', 'checkbox');
        card.setAttribute('aria-checked', p.selected ? 'true' : 'false');
        card.setAttribute('tabindex', '0');

        card.addEventListener('click', () => {
            p.selected = !p.selected;
            savePlaylists();
            renderPlaylists();
        });

        card.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                card.click();
            }
        });

        grid.appendChild(card);
    });

    updateSelectionCounter();
}

function updateSelectionCounter() {
    const selected = state.playlists.filter(p => p.selected);
    const totalTracks = selected.reduce((sum, p) => sum + (p.tracksCount || 0), 0);
    document.getElementById('selection-counter').textContent = `${selected.length} seleccionadas (${totalTracks} canciones)`;
}

// Select/Deselect All buttons
document.getElementById('btn-select-all').addEventListener('click', () => {
    state.playlists.forEach(p => p.selected = true);
    savePlaylists();
    renderPlaylists();
});

document.getElementById('btn-deselect-all').addEventListener('click', () => {
    state.playlists.forEach(p => p.selected = false);
    savePlaylists();
    renderPlaylists();
});

document.getElementById('input-search-playlists').addEventListener('input', () => {
    renderPlaylists();
});

// JSON Backup & Import
document.getElementById('btn-export-json').addEventListener('click', async () => {
    const selected = state.playlists.filter(p => p.selected);
    if (selected.length === 0) {
        alert('Selecciona al menos una lista para exportar.');
        return;
    }

    const exportBtn = document.getElementById('btn-export-json');
    const oldText = exportBtn.innerHTML;
    exportBtn.innerHTML = `⏳ Preparando respaldo...`;

    const srcPlat = getSourcePlatform();
    const token = getSourceToken();
    const exportData = [];

    for (const pl of selected) {
        let tracks = [];
        try {
            if (srcPlat === 'youtube') {
                tracks = await fetchYouTubePlaylistTracks(token, pl.id);
            } else if (pl.isLikedSongs) {
                tracks = await fetchLikedSongsTracks(token);
            } else {
                tracks = await fetchPlaylistTracks(token, pl.id);
            }
        } catch (e) {
            console.warn(`No se pudieron exportar pistas de ${pl.name}:`, e);
        }
        exportData.push({
            name: pl.name,
            id: pl.id,
            description: pl.description,
            platform: srcPlat,
            isLikedSongs: pl.isLikedSongs,
            isOwned: pl.isOwned,
            tracks: tracks
        });
    }

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `musictransferly-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);

    exportBtn.innerHTML = oldText;
});

document.getElementById('input-import-json').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const data = JSON.parse(event.target.result);
            if (!Array.isArray(data)) throw new Error('Formato JSON no válido.');

            state.playlists = data.map((item, idx) => ({
                id: item.id || `imported_${idx}`,
                name: item.name || `Lista ${idx + 1}`,
                description: item.description || '',
                tracksCount: (item.tracks || []).length,
                imageUrl: '',
                platform: item.platform || 'json',
                isLikedSongs: !!item.isLikedSongs,
                isOwned: item.isOwned ?? true,
                selected: true,
                tracks: item.tracks || []
            }));

            savePlaylists();
            document.getElementById('source-name').textContent = 'Respaldo JSON Importado';
            document.getElementById('source-email').textContent = `${state.playlists.length} listas cargadas`;
            document.getElementById('source-content').classList.remove('hidden');
            renderPlaylists();
            alert('¡Respaldo importado correctamente!');
        } catch (err) {
            alert('Error leyendo archivo JSON: ' + err.message);
        }
    };
    reader.readAsText(file);
});

// Proceed to Step 3
document.getElementById('btn-go-to-dest').addEventListener('click', () => {
    const selected = state.playlists.filter(p => p.selected);
    if (selected.length === 0) {
        alert('Por favor selecciona al menos una lista para transferir.');
        return;
    }

    savePlaylists();
    updateDestinationSummary();
    setStep(3);
});

// ==========================================
// 9. Step 3: Destination Account Logic
// ==========================================
document.getElementById('btn-login-dest').addEventListener('click', () => {
    const dest403 = document.getElementById('dest-403-banner');
    if (dest403) dest403.classList.add('hidden');
    savePlaylists();
    initiateAuth('destination');
});

document.getElementById('btn-back-to-source').addEventListener('click', () => {
    setStep(2);
});

async function checkDestinationProfile() {
    const dstPlat = getDestPlatform();
    const token = getDestToken();
    if (!token) return;

    try {
        if (dstPlat === 'youtube') {
            const profile = await loadGoogleProfile(token);
            state.ytDestProfile = profile;
            sessionStorage.setItem('yt_dest_profile', JSON.stringify(profile));

            document.getElementById('dest-name').textContent = profile.name || profile.email;
            document.getElementById('dest-email').textContent = profile.email || `ID: ${profile.id}`;
            if (profile.picture) {
                document.getElementById('dest-avatar').innerHTML = `<img src="${escapeHtml(profile.picture)}" class="w-full h-full object-cover rounded-full" alt="avatar">`;
            }
            document.getElementById('btn-login-dest').textContent = 'Cambiar cuenta YouTube destino';
        } else {
            const profile = await spotifyApi(token, '/me');
            state.destProfile = profile;
            sessionStorage.setItem('spot_dest_profile', JSON.stringify(profile));

            document.getElementById('dest-name').textContent = profile.display_name || profile.id;
            document.getElementById('dest-email').textContent = profile.email || `ID: ${profile.id}`;
            if (profile.images && profile.images.length > 0) {
                document.getElementById('dest-avatar').innerHTML = `<img src="${escapeHtml(profile.images[0].url)}" class="w-full h-full object-cover rounded-full" alt="avatar">`;
            }
            document.getElementById('btn-login-dest').textContent = 'Cambiar cuenta Spotify destino';
        }

        // Advertencia si es exactamente la misma cuenta en la misma plataforma
        const warning = document.getElementById('warning-same-account');
        const srcProfile = getSourceProfile();
        const dstProfile = getDestProfile();
        if (getSourcePlatform() === dstPlat && srcProfile && dstProfile && srcProfile.id === dstProfile.id) {
            warning.classList.remove('hidden');
        } else {
            warning.classList.add('hidden');
        }

        const banner403 = document.getElementById('dest-403-banner');
        if (banner403) banner403.classList.add('hidden');

        document.getElementById('dest-options-card').classList.remove('hidden');
        updateDestinationSummary();
    } catch (err) {
        console.error('Error cargando destino:', err);
        if (dstPlat === 'youtube') {
            state.ytDestToken = '';
            sessionStorage.removeItem('yt_dest_token');
        } else {
            state.destToken = '';
            sessionStorage.removeItem('spot_dest_token');
        }

        if (isForbidden(err) && dstPlat === 'spotify') {
            const banner403 = document.getElementById('dest-403-banner');
            if (banner403) banner403.classList.remove('hidden');
            alert('⚠️ Error 403: Tu cuenta de DESTINO no está registrada en "Users and Access" de tu Spotify Developer Dashboard.');
        } else {
            alert('Error al verificar cuenta de destino: ' + err.message);
        }
    }
}

// Start transfer button
document.getElementById('btn-start-transfer').addEventListener('click', () => {
    const token = getDestToken();
    if (!token) {
        alert('Por favor conecta primero tu Cuenta de Destino.');
        return;
    }

    const selectedPlaylists = state.playlists.filter(p => p.selected);
    if (selectedPlaylists.length === 0) {
        alert('No tienes ninguna playlist seleccionada para transferir. Vuelve al Paso 2 y selecciona tus listas.');
        setStep(2);
        return;
    }

    const srcProfile = getSourceProfile();
    const dstProfile = getDestProfile();
    if (getSourcePlatform() === getDestPlatform() && srcProfile && dstProfile && srcProfile.id === dstProfile.id) {
        if (!confirm('⚠️ Advertencia: Ambas cuentas tienen el mismo ID. ¿Estás seguro de que deseas duplicar las listas en la misma cuenta?')) {
            return;
        }
    }

    executeTransfer();
});

// ==========================================
// 10. Step 4 & 5: Transfer Engine (Bidirectional)
// ==========================================
function logMessage(msg) {
    const consoleBox = document.getElementById('live-console');
    const time = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.innerHTML = `<span class="text-gray-500">[${time}]</span> ${msg}`;
    consoleBox.appendChild(line);
    consoleBox.scrollTop = consoleBox.scrollHeight;
}

// Fetch tracks helper for Spotify owned playlist
async function fetchPlaylistTracks(token, playlistId) {
    let tracks = [];
    let url = `/playlists/${playlistId}/items?limit=100`;

    try {
        while (url) {
            const res = await spotifyApi(token, url);
            if (res && res.items) {
                res.items.forEach(item => {
                    const trackObj = item?.track || item?.item;
                    if (trackObj?.uri && trackObj.uri.startsWith('spotify:track:') && !trackObj.is_local) {
                        tracks.push({
                            uri: trackObj.uri,
                            id: trackObj.id,
                            name: trackObj.name,
                            artist: trackObj.artists?.[0]?.name || ''
                        });
                    }
                });
            }
            url = res?.next || null;
        }
        return tracks;
    } catch (err) {
        if (err.status === 404) {
            url = `/playlists/${playlistId}/tracks?limit=100`;
            while (url) {
                const res = await spotifyApi(token, url);
                if (res && res.items) {
                    res.items.forEach(item => {
                        const trackObj = item?.track;
                        if (trackObj?.uri && trackObj.uri.startsWith('spotify:track:') && !trackObj.is_local) {
                            tracks.push({
                                uri: trackObj.uri,
                                id: trackObj.id,
                                name: trackObj.name,
                                artist: trackObj.artists?.[0]?.name || ''
                            });
                        }
                    });
                }
                url = res?.next || null;
            }
            return tracks;
        }
        throw err;
    }
}

// Fetch tracks helper for Spotify Liked Songs
async function fetchLikedSongsTracks(token) {
    let tracks = [];
    let url = `/me/tracks?limit=50`;
    while (url) {
        const res = await spotifyApi(token, url);
        if (res && res.items) {
            res.items.forEach(item => {
                const t = item?.track;
                if (t && t.id && t.uri && t.uri.startsWith('spotify:track:') && !t.is_local) {
                    tracks.push({
                        uri: t.uri,
                        id: t.id,
                        name: t.name,
                        artist: t.artists?.[0]?.name || ''
                    });
                }
            });
            logMessage(`  └ Leyendo canciones de Tus Me Gusta: ${tracks.length}...`);
        }
        url = res?.next || null;
    }
    return tracks;
}

// Create playlist on Spotify destination
async function createPlaylistOnDestination(token, destUserId, name, description, isPublic) {
    const body = JSON.stringify({
        name: name,
        description: description,
        public: isPublic
    });

    if (destUserId) {
        try {
            return await spotifyApi(token, `/users/${encodeURIComponent(destUserId)}/playlists`, {
                method: 'POST',
                body: body
            });
        } catch (e) {
            console.warn('Fallback a /me/playlists:', e);
        }
    }

    return await spotifyApi(token, `/me/playlists`, {
        method: 'POST',
        body: body
    });
}

// Add tracks to Spotify playlist
async function addItemsToPlaylist(token, playlistId, uris) {
    try {
        await spotifyApi(token, `/playlists/${playlistId}/items`, {
            method: 'POST',
            body: JSON.stringify({ uris: uris })
        });
    } catch (e) {
        await spotifyApi(token, `/playlists/${playlistId}/tracks`, {
            method: 'POST',
            body: JSON.stringify({ uris: uris })
        });
    }
}

// Save tracks with heart ❤️ to Spotify library
async function saveLikedTracksToLibrary(token, trackUris) {
    if (!trackUris || trackUris.length === 0) return 0;

    let saved = 0;
    const batchSize = 50;

    for (let b = 0; b < trackUris.length; b += batchSize) {
        const batch = trackUris.slice(b, b + batchSize);
        const ids = batch.map(u => u.split(':').pop()).filter(Boolean);

        try {
            await spotifyApi(token, `/me/tracks`, {
                method: 'PUT',
                body: JSON.stringify({ ids: ids })
            });
            saved += batch.length;
            logMessage(`  └ Corazones guardados: ${saved} / ${trackUris.length}`);
        } catch (tracksErr) {
            console.warn('PUT /me/tracks falló, probando fallback /me/library:', tracksErr);
            try {
                const urisParam = encodeURIComponent(batch.join(','));
                await spotifyApi(token, `/me/library?uris=${urisParam}`, { method: 'PUT' });
                saved += batch.length;
            } catch (libErr) {
                throw tracksErr;
            }
        }
        await sleep(150);
    }
    return saved;
}

// Save/follow Spotify playlist
async function savePlaylistToDestinationLibrary(token, playlistId) {
    try {
        await spotifyApi(token, `/playlists/${encodeURIComponent(playlistId)}/followers`, {
            method: 'PUT',
            body: JSON.stringify({ public: false })
        });
        return true;
    } catch (e) {
        await spotifyApi(token, `/me/library?uris=spotify:playlist:${encodeURIComponent(playlistId)}`, {
            method: 'PUT'
        });
        return true;
    }
}

// Motor de transferencia Bidireccional
async function executeTransfer() {
    setStep(4);
    state.isTransferring = true;

    const selectedPlaylists = state.playlists.filter(p => p.selected);
    const isPrivate = document.getElementById('opt-private').checked;
    const heartLikedSongs = document.getElementById('opt-heart-songs').checked;

    const srcPlat = getSourcePlatform();
    const dstPlat = getDestPlatform();
    const srcToken = getSourceToken();
    const dstToken = getDestToken();

    let totalTracksTransferred = 0;
    let completedPlaylists = 0;
    const finalCreatedList = [];

    const statPlaylists = document.getElementById('stat-playlists');
    const statTracks = document.getElementById('stat-tracks');
    const statStatus = document.getElementById('stat-status');
    const progressFill = document.getElementById('progress-bar-fill');
    const progressPercent = document.getElementById('progress-percentage');
    const currentTask = document.getElementById('current-task-text');

    statPlaylists.textContent = `0 / ${selectedPlaylists.length}`;
    statTracks.textContent = '0';
    statStatus.textContent = 'Iniciando...';

    const routeLabel = `${srcPlat.toUpperCase()} ➔ ${dstPlat.toUpperCase()}`;
    logMessage(`🚀 Comenzando transferencia [${routeLabel}] de ${selectedPlaylists.length} listas...`);

    // Perfil destino
    let destUserId = '';
    if (dstPlat === 'spotify') {
        if (!state.destProfile || !state.destProfile.id) {
            try {
                state.destProfile = await spotifyApi(dstToken, '/me');
            } catch (e) {
                console.warn('No se pudo refrescar perfil destino Spotify:', e);
            }
        }
        destUserId = state.destProfile?.id || '';
    }

    for (let i = 0; i < selectedPlaylists.length; i++) {
        const pl = selectedPlaylists[i];

        try {
            currentTask.textContent = `[${i + 1}/${selectedPlaylists.length}] "${escapeHtml(pl.name)}"`;
            statStatus.textContent = `Procesando: ${escapeHtml(pl.name)}`;
            logMessage(`📂 [${i + 1}/${selectedPlaylists.length}] Procesando lista: <strong>${escapeHtml(pl.name)}</strong>...`);

            // PASO A: Obtener pistas desde el origen
            let tracks = [];
            if (Array.isArray(pl.tracks) && pl.tracks.length > 0) {
                logMessage(`  └ Usando ${pl.tracks.length} canciones cargadas del respaldo JSON.`);
                tracks = pl.tracks;
            } else if (srcPlat === 'youtube') {
                tracks = await fetchYouTubePlaylistTracks(srcToken, pl.id);
                logMessage(`  ✔ Obtenidos ${tracks.length} videos de YouTube.`);
            } else {
                // Origen es Spotify
                if (pl.isLikedSongs) {
                    tracks = await fetchLikedSongsTracks(srcToken);
                    logMessage(`  ✔ Obtenidas ${tracks.length} canciones de Tus Me Gusta.`);
                } else {
                    tracks = await fetchPlaylistTracks(srcToken, pl.id);
                    logMessage(`  ✔ Obtenidas ${tracks.length} canciones.`);
                }
            }

            // PASO B: Destino YouTube Music
            if (dstPlat === 'youtube') {
                const createPlName = pl.isLikedSongs ? 'Mis Me Gusta (Spotify)' : pl.name;
                logMessage(`  🛠 Creando playlist en YouTube Music: <strong>${escapeHtml(createPlName)}</strong>...`);

                const newYtPl = await createYouTubePlaylist(
                    dstToken,
                    createPlName,
                    pl.description || 'Migrada exitosamente con MusicTransferly',
                    isPrivate
                );

                const ytPlaylistId = newYtPl.id;
                let addedCount = 0;

                for (let t = 0; t < tracks.length; t++) {
                    const track = tracks[t];
                    let videoId = track.videoId;

                    // Si venimos de Spotify o JSON sin videoId, buscar el video en YouTube
                    if (!videoId) {
                        currentTask.textContent = `Buscando en YouTube: ${track.name} - ${track.artist}`;
                        videoId = await searchYouTubeVideo(dstToken, track.name, track.artist);
                    }

                    if (videoId) {
                        try {
                            await addVideoToYouTubePlaylist(dstToken, ytPlaylistId, videoId);
                            addedCount++;
                            totalTracksTransferred++;
                            statTracks.textContent = totalTracksTransferred;
                        } catch (addErr) {
                            console.warn(`Error al añadir video ${videoId}:`, addErr);
                        }
                    } else {
                        logMessage(`  ⚠️ No se encontró video en YouTube para: ${escapeHtml(track.name)} - ${escapeHtml(track.artist || '')}`);
                    }

                    // Pausa ligera para evitar exceder rate limit
                    await sleep(100);
                }

                logMessage(`  ✅ Añadidos ${addedCount} / ${tracks.length} videos a la playlist de YouTube.`);
                finalCreatedList.push({
                    name: createPlName,
                    url: `https://music.youtube.com/playlist?list=${ytPlaylistId}`,
                    tracksCount: addedCount
                });

            } else {
                // PASO C: Destino Spotify
                let trackUris = [];

                if (srcPlat === 'youtube') {
                    // Mapear videos de YouTube a tracks de Spotify con limpieza de títulos
                    logMessage(`  🔍 Emparejando canciones de YouTube con el catálogo de Spotify...`);
                    for (let t = 0; t < tracks.length; t++) {
                        const tr = tracks[t];
                        currentTask.textContent = `Buscando en Spotify: ${tr.name}`;
                        const uri = await searchSpotifyTrack(dstToken, tr.name, tr.artist);
                        if (uri) {
                            trackUris.push(uri);
                        } else {
                            logMessage(`  ⚠️ Sin coincidencia en Spotify: ${escapeHtml(tr.name)}`);
                        }
                        await sleep(80);
                    }
                    logMessage(`  ✔ Emparejadas ${trackUris.length} / ${tracks.length} canciones.`);
                } else {
                    // Origen Spotify directo
                    trackUris = tracks.map(t => t.uri).filter(uri => uri && uri.startsWith('spotify:track:'));
                }

                // Guardar Me Gusta con corazón si corresponde
                if (pl.isLikedSongs && heartLikedSongs && trackUris.length > 0) {
                    currentTask.textContent = `Guardando en tus "Me Gusta"...`;
                    logMessage(`  ❤️ Añadiendo a tus "Canciones que te gustan" con corazón...`);
                    try {
                        const heartsSaved = await saveLikedTracksToLibrary(dstToken, trackUris);
                        logMessage(`  ✅ ¡${heartsSaved} canciones marcadas con corazón ❤️!`);
                    } catch (hErr) {
                        logMessage(`  ⚠️ Error al marcar corazones: ${escapeHtml(hErr.message)}`);
                    }
                }

                // Crear playlist en Spotify
                const createPlName = pl.isLikedSongs ? 'Mis Me Gusta (Transferidos)' : pl.name;
                logMessage(`  🛠 Creando playlist <strong>${escapeHtml(createPlName)}</strong> en Spotify destino...`);

                const newPlaylist = await createPlaylistOnDestination(
                    dstToken,
                    destUserId,
                    createPlName,
                    pl.description || 'Migrada exitosamente con MusicTransferly',
                    !isPrivate
                );

                const newPlaylistId = newPlaylist.id;
                finalCreatedList.push({
                    name: createPlName,
                    url: newPlaylist.external_urls?.spotify || `https://open.spotify.com/playlist/${newPlaylistId}`,
                    tracksCount: trackUris.length
                });

                // Añadir canciones en lotes de 100
                if (trackUris.length > 0) {
                    for (let b = 0; b < trackUris.length; b += 100) {
                        const batch = trackUris.slice(b, b + 100);
                        await addItemsToPlaylist(dstToken, newPlaylistId, batch);
                        totalTracksTransferred += batch.length;
                        statTracks.textContent = totalTracksTransferred;
                        logMessage(`  └ Canciones añadidas: ${Math.min(b + 100, trackUris.length)} / ${trackUris.length}`);
                        await sleep(150);
                    }
                }
            }

            completedPlaylists++;
            statPlaylists.textContent = `${completedPlaylists} / ${selectedPlaylists.length}`;

            const percentage = Math.round((completedPlaylists / selectedPlaylists.length) * 100);
            progressFill.style.width = `${percentage}%`;
            progressFill.setAttribute('aria-valuenow', percentage);
            progressPercent.textContent = `${percentage}%`;

            logMessage(`✅ Lista <strong>${escapeHtml(pl.name)}</strong> transferida con éxito.`);
            await sleep(250);

        } catch (err) {
            console.error(`Error transfiriendo lista ${pl.name}:`, err);
            logMessage(`<span class="text-red-400">❌ Error al transferir "${escapeHtml(pl.name)}": ${escapeHtml(err.message)}</span>`);
        }
    }

    statStatus.textContent = '¡Completado!';
    currentTask.textContent = 'Proceso finalizado.';
    logMessage(`🎉 Proceso concluido. Total de listas creadas: ${completedPlaylists}.`);

    await sleep(1200);

    // Step 5: Completado
    document.getElementById('final-playlists-count').textContent = completedPlaylists;
    document.getElementById('final-tracks-count').textContent = totalTracksTransferred;

    const finalListContainer = document.getElementById('final-playlists-list');
    finalListContainer.innerHTML = '';

    if (finalCreatedList.length === 0) {
        finalListContainer.innerHTML = `<div class="text-gray-400 py-3 text-center">No se pudo crear ninguna lista. Revisa los mensajes en la consola.</div>`;
    } else {
        finalCreatedList.forEach(item => {
            const row = document.createElement('div');
            row.className = 'flex items-center justify-between p-2 rounded-lg bg-spotify-dark/60 border border-spotify-border/60 hover:border-spotify-green transition';

            const safeUrl = (typeof item.url === 'string' && (item.url.startsWith('https://open.spotify.com/') || item.url.startsWith('https://music.youtube.com/') || item.url.startsWith('https://www.youtube.com/')))
                ? item.url
                : '#';

            row.innerHTML = `
                <span class="font-medium text-white truncate mr-2">🎵 ${escapeHtml(item.name)} <span class="text-gray-500">(${Number(item.tracksCount) || 0} canciones)</span></span>
                <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="text-spotify-green hover:underline flex-shrink-0 flex items-center gap-1">
                    Abrir ↗
                </a>
            `;
            finalListContainer.appendChild(row);
        });
    }

    state.isTransferring = false;
    setStep(5);
}

// Alerta ante cierre accidental
window.addEventListener('beforeunload', (e) => {
    if (state.isTransferring) {
        e.preventDefault();
        e.returnValue = 'Hay una transferencia en curso. Si cierras la ventana, el proceso se interrumpirá.';
    }
});

// Reinicios
document.getElementById('btn-restart').addEventListener('click', () => {
    setStep(2);
});

document.getElementById('btn-reset-app').addEventListener('click', () => {
    if (confirm('¿Deseas reiniciar la aplicación y borrar las credenciales guardadas en este navegador?')) {
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = '/';
    }
});

// ==========================================
// 11. Init & OAuth Callback Handling
// ==========================================
async function init() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const authError = urlParams.get('error');

    if (authError) {
        alert('Error de autorización: ' + authError);
        window.history.replaceState({}, document.title, '/');
    } else if (code) {
        const expectedState = sessionStorage.getItem('oauth_expected_state');
        const platform = sessionStorage.getItem('oauth_platform') || 'spotify';
        const mode = sessionStorage.getItem('oauth_auth_mode') || 'source';
        const verifier = sessionStorage.getItem('oauth_code_verifier') || '';

        sessionStorage.removeItem('oauth_expected_state');
        sessionStorage.removeItem('oauth_code_verifier');
        window.history.replaceState({}, document.title, '/');

        if (!expectedState || urlParams.get('state') !== expectedState) {
            alert('La respuesta de autorización no corresponde a esta sesión. Vuelve a conectar tu cuenta.');
            setStep(mode === 'source' ? 2 : 3);
            return;
        }

        if (!verifier) {
            alert('No se encontró el código de verificación (PKCE). Por favor vuelve a hacer clic en Conectar.');
            setStep(mode === 'source' ? 2 : 3);
            return;
        }

        try {
            if (platform === 'google') {
                const tokenData = await exchangeGoogleCode(code, verifier);
                if (tokenData.access_token) {
                    if (mode === 'source') {
                        state.ytSourceToken = tokenData.access_token;
                        sessionStorage.setItem('yt_source_token', tokenData.access_token);
                        if (tokenData.refresh_token) {
                            state.ytSourceRefreshToken = tokenData.refresh_token;
                            sessionStorage.setItem('yt_source_refresh_token', tokenData.refresh_token);
                        }
                        setStep(2);
                        await loadSourceProfileAndPlaylists();
                        return;
                    } else {
                        state.ytDestToken = tokenData.access_token;
                        sessionStorage.setItem('yt_dest_token', tokenData.access_token);
                        if (tokenData.refresh_token) {
                            state.ytDestRefreshToken = tokenData.refresh_token;
                            sessionStorage.setItem('yt_dest_refresh_token', tokenData.refresh_token);
                        }
                        setStep(3);
                        updateDestinationSummary();
                        await checkDestinationProfile();
                        return;
                    }
                } else {
                    throw new Error(tokenData.error_description || tokenData.error || 'Respuesta no válida de Google');
                }
            } else {
                // Spotify
                const tokenData = await exchangeSpotifyCode(code, verifier);
                if (tokenData.access_token) {
                    if (mode === 'source') {
                        state.sourceToken = tokenData.access_token;
                        sessionStorage.setItem('spot_source_token', tokenData.access_token);
                        if (tokenData.refresh_token) {
                            state.sourceRefreshToken = tokenData.refresh_token;
                            sessionStorage.setItem('spot_source_refresh_token', tokenData.refresh_token);
                        }
                        setStep(2);
                        await loadSourceProfileAndPlaylists();
                        return;
                    } else {
                        state.destToken = tokenData.access_token;
                        sessionStorage.setItem('spot_dest_token', tokenData.access_token);
                        if (tokenData.refresh_token) {
                            state.destRefreshToken = tokenData.refresh_token;
                            sessionStorage.setItem('spot_dest_refresh_token', tokenData.refresh_token);
                        }
                        setStep(3);
                        updateDestinationSummary();
                        await checkDestinationProfile();
                        return;
                    }
                } else {
                    throw new Error(tokenData.error_description || tokenData.error || 'Respuesta no válida de Spotify');
                }
            }
        } catch (err) {
            console.error('Error al intercambiar código:', err);
            alert('Error al autenticar: ' + err.message);
        }
    }

    // Default routing
    const srcPlat = getSourcePlatform();
    const dstPlat = getDestPlatform();
    const needsSpot = srcPlat === 'spotify' || dstPlat === 'spotify';
    const needsGoogle = srcPlat === 'youtube' || dstPlat === 'youtube';

    if ((needsSpot && !state.clientId) || (needsGoogle && !state.googleClientId)) {
        setStep(1);
    } else if (getDestToken() && state.playlists.length > 0) {
        setStep(3);
        updateDestinationSummary();
        checkDestinationProfile();
    } else if (getSourceToken()) {
        setStep(2);
        if (state.playlists.length > 0) {
            document.getElementById('source-content').classList.remove('hidden');
            renderPlaylists();
            const prof = getSourceProfile();
            if (prof) {
                document.getElementById('source-name').textContent = prof.display_name || prof.name || prof.id;
                document.getElementById('source-email').textContent = prof.email || `ID: ${prof.id}`;
            }
        } else {
            loadSourceProfileAndPlaylists();
        }
    } else {
        setStep(2);
    }
}

init();
