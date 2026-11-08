/**
 * ====================================================================
 * MusicTransferly - Motor Universal de Migración Musical
 * Spotify ⇄ YouTube Music ⇄ Deezer (Cualquier origen a cualquier destino)
 * ====================================================================
 * ¿CÓMO FUNCIONA LA TRANSFERENCIA UNIVERSAL?
 * 
 * 1. AUTENTICACIÓN SEGURA MULTI-PROVEEDOR:
 *    - Spotify & Google/YouTube: Estándar OAuth 2.0 PKCE (RFC 7636) con hash SHA-256.
 *    - Deezer: OAuth 2.0 a través del proxy local en 127.0.0.1 (evitando CORS).
 *    - Todos los tokens residen exclusivamente en `sessionStorage` (destruidos al cerrar la pestaña).
 * 
 * 2. MATRIZ DE MIGRACIÓN CRUZADA (9 RUTAS POSIBLES + JSON):
 *    - Spotify ➔ YouTube Music / Deezer / Spotify
 *    - YouTube Music ➔ Spotify / Deezer / YouTube
 *    - Deezer ➔ Spotify / YouTube Music / Deezer
 *    - Exportación e importación universal en formato JSON offline.
 * 
 * 3. ALGORITMOS DE EMPAREJAMIENTO INTELIGENTE:
 *    - YouTube: Normalizador y limpiador heurístico de títulos (`cleanYouTubeTitle`).
 *    - Spotify: Búsqueda escalonada con campos exactos entrecomillados y fallback libre.
 *    - Deezer: Búsqueda cruzada por metadatos (ISRC, track, artist) y lotes optimizados.
 *    - Control de límites de cuota (YouTube quotaExceeded, Spotify 429 Retry-After, Deezer limits).
 * ====================================================================
 */

// Forzar 127.0.0.1 para mantener localStorage y sessionStorage idénticos en redirecciones
if (window.location.hostname === 'localhost') {
    window.location.replace(window.location.href.replace('localhost', '127.0.0.1'));
}

// Global State
const currentPort = window.location.port ? `:${window.location.port}` : '';
const state = {
    step: 1,
    sourcePlatform: localStorage.getItem('source_platform') || 'spotify',
    destPlatform: localStorage.getItem('dest_platform') || 'youtube',
    redirectUri: `${window.location.protocol}//127.0.0.1${currentPort}/callback`,

    // Spotify Credentials & Tokens
    clientId: localStorage.getItem('spot_client_id') || '',
    sourceToken: sessionStorage.getItem('spot_source_token') || '',
    sourceRefreshToken: sessionStorage.getItem('spot_source_refresh_token') || '',
    sourceProfile: JSON.parse(sessionStorage.getItem('spot_source_profile') || 'null'),
    destToken: sessionStorage.getItem('spot_dest_token') || '',
    destRefreshToken: sessionStorage.getItem('spot_dest_refresh_token') || '',
    destProfile: JSON.parse(sessionStorage.getItem('spot_dest_profile') || 'null'),

    // Google / YouTube Credentials & Tokens
    googleClientId: localStorage.getItem('google_client_id') || '',
    googleClientSecret: localStorage.getItem('google_client_secret') || '',
    ytSourceToken: sessionStorage.getItem('yt_source_token') || '',
    ytSourceRefreshToken: sessionStorage.getItem('yt_source_refresh_token') || '',
    ytSourceProfile: JSON.parse(sessionStorage.getItem('yt_source_profile') || 'null'),
    ytDestToken: sessionStorage.getItem('yt_dest_token') || '',
    ytDestRefreshToken: sessionStorage.getItem('yt_dest_refresh_token') || '',
    ytDestProfile: JSON.parse(sessionStorage.getItem('yt_dest_profile') || 'null'),

    // Deezer Credentials & Tokens
    deezerAppId: localStorage.getItem('deezer_app_id') || '',
    deezerSecret: localStorage.getItem('deezer_secret') || '',
    deezerSourceToken: sessionStorage.getItem('deezer_source_token') || '',
    deezerSourceProfile: JSON.parse(sessionStorage.getItem('deezer_source_profile') || 'null'),
    deezerDestToken: sessionStorage.getItem('deezer_dest_token') || '',
    deezerDestProfile: JSON.parse(sessionStorage.getItem('deezer_dest_profile') || 'null'),

    // Playlists & Transfer state
    playlists: JSON.parse(localStorage.getItem('spot_playlists') || '[]'),
    likedSongsTotal: parseInt(localStorage.getItem('spot_liked_total') || '0', 10),
    isTransferring: false
};

// Limpieza de seguridad: borrar cualquier token residual de localStorage antiguo
['spot_source_token', 'spot_dest_token', 'spot_source_refresh_token', 'spot_dest_refresh_token',
 'yt_source_token', 'yt_dest_token', 'yt_source_refresh_token', 'yt_dest_refresh_token',
 'deezer_source_token', 'deezer_dest_token'].forEach(k => localStorage.removeItem(k));

// Platform mapping helpers
function getSourcePlatform() {
    return state.sourcePlatform;
}

function getDestPlatform() {
    return state.destPlatform;
}

function getSourceToken() {
    const p = getSourcePlatform();
    if (p === 'youtube') return state.ytSourceToken;
    if (p === 'deezer') return state.deezerSourceToken;
    return state.sourceToken;
}

function getDestToken() {
    const p = getDestPlatform();
    if (p === 'youtube') return state.ytDestToken;
    if (p === 'deezer') return state.deezerDestToken;
    return state.destToken;
}

function getSourceProfile() {
    const p = getSourcePlatform();
    if (p === 'youtube') return state.ytSourceProfile;
    if (p === 'deezer') return state.deezerSourceProfile;
    return state.sourceProfile;
}

function getDestProfile() {
    const p = getDestPlatform();
    if (p === 'youtube') return state.ytDestProfile;
    if (p === 'deezer') return state.deezerDestProfile;
    return state.destProfile;
}

function getPlatformIcon(platform) {
    if (platform === 'youtube') return '🔴';
    if (platform === 'deezer') return '🟣';
    return '🟢';
}

function getPlatformName(platform) {
    if (platform === 'youtube') return 'YouTube Music';
    if (platform === 'deezer') return 'Deezer';
    return 'Spotify';
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

// Check if error is quota exceeded
function isQuotaExceeded(err) {
    if (!err) return false;
    if (err.isQuotaExceeded) return true;
    const msg = (err.message || '').toLowerCase();
    return msg.includes('quotaexceeded') || msg.includes('quota exceeded') || msg.includes('cuota diaria de youtube superada');
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
// 1. PKCE & OAuth Helper Functions
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
// 1.1 Config Loader & Credential Prompt Modal
// ==========================================
async function loadServerConfig() {
    try {
        const res = await fetch('/api/config');
        if (res.ok) {
            const cfg = await res.json();
            if (cfg.spotifyClientId && !state.clientId) {
                state.clientId = cfg.spotifyClientId;
            }
            if (cfg.googleClientId && !state.googleClientId) {
                state.googleClientId = cfg.googleClientId;
            }
            if (cfg.deezerAppId && !state.deezerAppId) {
                state.deezerAppId = cfg.deezerAppId;
            }
            state.hasGoogleSecret = Boolean(cfg.hasGoogleSecret);
            state.hasDeezerSecret = Boolean(cfg.hasDeezerSecret);

            const inpSpot = document.getElementById('input-client-id');
            const inpGoogle = document.getElementById('input-google-client-id');
            const inpDeezer = document.getElementById('input-deezer-app-id');
            if (inpSpot && state.clientId) inpSpot.value = state.clientId;
            if (inpGoogle && state.googleClientId) inpGoogle.value = state.googleClientId;
            if (inpDeezer && state.deezerAppId) inpDeezer.value = state.deezerAppId;
        }
    } catch (e) {
        console.warn('No se pudo cargar /api/config:', e);
    }
}

function promptCredentialModal({ platform, onSave }) {
    const modal = document.getElementById('modal-credential');
    const icon = document.getElementById('modal-cred-icon');
    const title = document.getElementById('modal-cred-title');
    const subtitle = document.getElementById('modal-cred-subtitle');
    const body = document.getElementById('modal-cred-body');
    const btnSubmit = document.getElementById('btn-submit-cred-modal');

    if (!modal || !body || !btnSubmit) return;

    icon.textContent = getPlatformIcon(platform);
    title.textContent = `Conectar con ${getPlatformName(platform)}`;
    subtitle.textContent = `Configuración única para tu navegador local o config.json`;

    if (platform === 'spotify') {
        body.innerHTML = `
            <p class="text-gray-300">Para conectar tu cuenta de Spotify de forma 100% privada y directa en tu PC, ingresa tu <strong class="text-white">Spotify Client ID</strong> gratuito:</p>
            <input type="text" id="modal-input-spot" placeholder="Ej: 3a7b9c1d8e2f..." class="w-full bg-spotify-dark border border-spotify-border focus:border-spotify-green focus:ring-1 focus:ring-spotify-green rounded-xl px-4 py-2.5 text-white font-mono text-xs placeholder-gray-600 outline-none" value="${escapeHtml(state.clientId)}">
            <p class="text-[11px] text-gray-400">¿No tienes uno? Créalo en 1 minuto en <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener noreferrer" class="text-spotify-green underline font-bold">Spotify Developer Dashboard</a> con Redirect URI <code class="text-spotify-green font-mono">${escapeHtml(state.redirectUri)}</code>.</p>
        `;
    } else if (platform === 'youtube') {
        const secPlaceholder = state.hasGoogleSecret ? 'Configurado en servidor (opcional)' : 'Google Client Secret';
        body.innerHTML = `
            <p class="text-gray-300">Para conectar con YouTube Music de forma local, ingresa tus credenciales de Google Cloud:</p>
            <div class="space-y-2">
                <input type="text" id="modal-input-google-id" placeholder="Google Client ID (.apps.googleusercontent.com)" class="w-full bg-spotify-dark border border-spotify-border focus:border-red-500 focus:ring-1 focus:ring-red-500 rounded-xl px-4 py-2 text-white font-mono text-xs placeholder-gray-600 outline-none" value="${escapeHtml(state.googleClientId)}">
                <input type="password" id="modal-input-google-secret" placeholder="${secPlaceholder}" class="w-full bg-spotify-dark border border-spotify-border focus:border-red-500 focus:ring-1 focus:ring-red-500 rounded-xl px-4 py-2 text-white font-mono text-xs placeholder-gray-600 outline-none" value="${escapeHtml(state.googleClientSecret)}">
            </div>
            <p class="text-[11px] text-gray-400">Creado en Google Cloud Console para aplicaciones web con Redirect URI <code class="text-red-400 font-mono">${escapeHtml(state.redirectUri)}</code>.</p>
        `;
    } else if (platform === 'deezer') {
        const dzSecPlaceholder = state.hasDeezerSecret ? 'Configurado en servidor (opcional)' : 'Deezer Secret Key';
        body.innerHTML = `
            <p class="text-gray-300">Para conectar con Deezer de forma local, ingresa tu App ID:</p>
            <div class="space-y-2">
                <input type="text" id="modal-input-deezer-id" placeholder="Deezer App ID (números)" class="w-full bg-spotify-dark border border-spotify-border focus:border-purple-500 focus:ring-1 focus:ring-purple-500 rounded-xl px-4 py-2 text-white font-mono text-xs placeholder-gray-600 outline-none" value="${escapeHtml(state.deezerAppId)}">
                <input type="password" id="modal-input-deezer-secret" placeholder="${dzSecPlaceholder}" class="w-full bg-spotify-dark border border-spotify-border focus:border-purple-500 focus:ring-1 focus:ring-purple-500 rounded-xl px-4 py-2 text-white font-mono text-xs placeholder-gray-600 outline-none" value="${escapeHtml(state.deezerSecret)}">
            </div>
            <p class="text-[11px] text-gray-400">Creado en Deezer Developer Portal con Redirect URI <code class="text-purple-400 font-mono">${escapeHtml(state.redirectUri)}</code>.</p>
        `;
    }

    modal.classList.remove('hidden');

    btnSubmit.onclick = () => {
        if (platform === 'spotify') {
            const val = document.getElementById('modal-input-spot')?.value.trim();
            if (!val) {
                alert('Por favor ingresa un Spotify Client ID.');
                return;
            }
            state.clientId = val;
            localStorage.setItem('spot_client_id', val);
            const inp = document.getElementById('input-client-id');
            if (inp) inp.value = val;
        } else if (platform === 'youtube') {
            const idVal = document.getElementById('modal-input-google-id')?.value.trim();
            const secVal = document.getElementById('modal-input-google-secret')?.value.trim();
            if (!idVal) {
                alert('Por favor ingresa tu Google Client ID.');
                return;
            }
            state.googleClientId = idVal;
            localStorage.setItem('google_client_id', idVal);
            if (secVal) {
                state.googleClientSecret = secVal;
                localStorage.setItem('google_client_secret', secVal);
            }
            const inpId = document.getElementById('input-google-client-id');
            const inpSec = document.getElementById('input-google-client-secret');
            if (inpId) inpId.value = idVal;
            if (inpSec) inpSec.value = secVal || '';
        } else if (platform === 'deezer') {
            const dzId = document.getElementById('modal-input-deezer-id')?.value.trim();
            const dzSec = document.getElementById('modal-input-deezer-secret')?.value.trim();
            if (!dzId) {
                alert('Por favor ingresa tu Deezer App ID.');
                return;
            }
            if (!dzSec && !state.hasDeezerSecret) {
                alert('Por favor ingresa tu Deezer Secret Key.');
                return;
            }
            state.deezerAppId = dzId;
            localStorage.setItem('deezer_app_id', dzId);
            if (dzSec) {
                state.deezerSecret = dzSec;
                localStorage.setItem('deezer_secret', dzSec);
            }
            const inpDzId = document.getElementById('input-deezer-app-id');
            const inpDzSec = document.getElementById('input-deezer-secret');
            if (inpDzId) inpDzId.value = dzId;
            if (inpDzSec && dzSec) inpDzSec.value = dzSec;
        }

        modal.classList.add('hidden');
        if (typeof onSave === 'function') onSave();
    };
}

// Cierre del modal de credenciales
document.getElementById('btn-close-cred-modal')?.addEventListener('click', () => {
    document.getElementById('modal-credential')?.classList.add('hidden');
});
document.getElementById('btn-cancel-cred-modal')?.addEventListener('click', () => {
    document.getElementById('modal-credential')?.classList.add('hidden');
});

// Cierre accesible con tecla Escape
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('modal-credential');
        if (modal && !modal.classList.contains('hidden')) {
            modal.classList.add('hidden');
        }
    }
});

// Iniciar autorización Spotify
async function initiateSpotifyAuth(mode) {
    if (!state.clientId) {
        promptCredentialModal({
            platform: 'spotify',
            onSave: () => initiateSpotifyAuth(mode)
        });
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

// Iniciar autorización Google / YouTube
async function initiateGoogleAuth(mode) {
    if (!state.googleClientId) {
        promptCredentialModal({
            platform: 'youtube',
            onSave: () => initiateGoogleAuth(mode)
        });
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

// Iniciar autorización Deezer
function initiateDeezerAuth(mode) {
    if (!state.deezerAppId || (!state.deezerSecret && !state.hasDeezerSecret)) {
        promptCredentialModal({
            platform: 'deezer',
            onSave: () => initiateDeezerAuth(mode)
        });
        return;
    }

    savePlaylists();

    const oauthState = `deezer_${mode}_${generateRandomString(24)}`;
    sessionStorage.setItem('oauth_expected_state', oauthState);
    sessionStorage.setItem('oauth_auth_mode', mode);
    sessionStorage.setItem('oauth_platform', 'deezer');

    const perms = 'basic_access,email,offline_access,manage_library,delete_library';
    const params = new URLSearchParams({
        app_id: state.deezerAppId,
        redirect_uri: state.redirectUri,
        response_type: 'code',
        perms: perms,
        state: oauthState
    });

    window.location.href = `https://connect.deezer.com/oauth/auth.php?${params.toString()}`;
}

// Despachador de login según plataforma del paso actual
function initiateAuth(target) {
    const platform = (target === 'source') ? getSourcePlatform() : getDestPlatform();
    if (platform === 'youtube') {
        initiateGoogleAuth(target);
    } else if (platform === 'deezer') {
        initiateDeezerAuth(target);
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
    if (state.googleClientSecret) {
        payload.set('client_secret', state.googleClientSecret);
    }

    const res = await fetch('/api/youtube/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString()
    });

    return await res.json();
}

// Exchange Deezer authorization code
async function exchangeDeezerCode(code) {
    const payload = new URLSearchParams({
        app_id: state.deezerAppId,
        code: code
    });
    if (state.deezerSecret) {
        payload.set('secret', state.deezerSecret);
    }

    const res = await fetch('/api/deezer/token', {
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
    if (state.googleClientSecret) {
        payload.set('client_secret', state.googleClientSecret);
    }

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
// 2. API Callers (Spotify, YouTube, Deezer)
// ==========================================

// Spotify API caller
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

                if ([400, 401, 403, 404].includes(res.status)) throw err;
                throw err;
            }

            if (!text || text.trim().length === 0) return null;
            try { return JSON.parse(text); } catch (e) { return text; }
        } catch (err) {
            if (err.status && [400, 401, 403, 404].includes(err.status)) throw err;
            if (attempts >= 5) throw err;
            await sleep(1000 * attempts);
        }
    }
}

// YouTube Data API caller
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
                let isQuota = false;
                try {
                    const errData = JSON.parse(text);
                    msg = errData.error?.message || msg;
                    const reason = errData.error?.errors?.[0]?.reason || '';
                    if (reason === 'quotaExceeded' || msg.toLowerCase().includes('quota')) {
                        isQuota = true;
                    }
                } catch (e) {
                    if (text && text.toLowerCase().includes('quota')) isQuota = true;
                }
                const err = new Error(isQuota ? 'Cuota diaria de YouTube superada (10,000 unidades). Google Cloud restablece la cuota a medianoche (PT).' : msg);
                err.status = res.status;
                err.statusText = res.statusText;
                err.isQuotaExceeded = isQuota;

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
            try { return JSON.parse(text); } catch (e) { return text; }
        } catch (err) {
            if (err.status && [400, 401, 403, 404].includes(err.status)) throw err;
            if (attempts >= 5) throw err;
            await sleep(1000 * attempts);
        }
    }
}

// Deezer REST API caller (vía proxy local para sortear CORS)
async function deezerApi(token, endpoint, options = {}) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const authedPath = `${endpoint}${separator}access_token=${encodeURIComponent(token)}`;
    const proxyUrl = `/api/deezer/proxy?path=${encodeURIComponent(authedPath)}`;

    let attempts = 0;
    while (attempts < 4) {
        attempts++;
        try {
            const res = await fetch(proxyUrl, options);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status} al consultar Deezer`);
            }
            const data = await res.json();
            if (data.error) {
                // Control de rate limit en Deezer
                if (data.error.code === 4 || (data.error.message || '').includes('quota')) {
                    logMessage(`[Aviso] Límite de Deezer alcanzado. Pausando 2s...`);
                    await sleep(2000);
                    continue;
                }
                throw new Error(data.error.message || 'Error en Deezer API');
            }
            return data;
        } catch (err) {
            if (attempts >= 4) throw err;
            await sleep(1000 * attempts);
        }
    }
}

// ==========================================
// 3. YouTube & Deezer Helper Functions
// ==========================================

// Google Profile
async function loadGoogleProfile(token) {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} al cargar perfil de Google`);
    return await res.json();
}

// YouTube Playlists
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
        if (isQuotaExceeded(e)) throw e;
        console.warn('Error en búsqueda de YouTube:', e);
    }

    try {
        const fallbackUrl = `/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query + ' audio')}`;
        const res2 = await youtubeApi(token, fallbackUrl);
        return res2?.items?.[0]?.id?.videoId || null;
    } catch (e2) {
        if (isQuotaExceeded(e2)) throw e2;
        return null;
    }
}

// Deezer Helpers
async function loadDeezerProfile(token) {
    const data = await deezerApi(token, '/user/me');
    return {
        id: data.id,
        name: data.name,
        email: data.email || '',
        picture: data.picture_medium || data.picture
    };
}

async function loadDeezerPlaylists(token) {
    let playlists = [];
    let url = '/user/me/playlists?limit=50';

    while (url) {
        const data = await deezerApi(token, url);
        if (data && data.data) {
            playlists = playlists.concat(data.data);
            url = data.next ? data.next.replace('https://api.deezer.com', '') : null;
        } else {
            break;
        }
    }
    return playlists;
}

async function fetchDeezerPlaylistTracks(token, playlistId) {
    let tracks = [];
    let url = `/playlist/${playlistId}/tracks?limit=100`;

    while (url) {
        const data = await deezerApi(token, url);
        if (data && data.data) {
            data.data.forEach(t => {
                tracks.push({
                    id: t.id,
                    name: t.title,
                    artist: t.artist?.name || '',
                    duration: t.duration,
                    isrc: t.isrc || ''
                });
            });
            url = data.next ? data.next.replace('https://api.deezer.com', '') : null;
        } else {
            break;
        }
    }
    return tracks;
}

async function fetchDeezerFavoriteTracks(token) {
    let tracks = [];
    let url = `/user/me/tracks?limit=100`;

    while (url) {
        const data = await deezerApi(token, url);
        if (data && data.data) {
            data.data.forEach(t => {
                tracks.push({
                    id: t.id,
                    name: t.title,
                    artist: t.artist?.name || '',
                    duration: t.duration
                });
            });
            url = data.next ? data.next.replace('https://api.deezer.com', '') : null;
        } else {
            break;
        }
    }
    return tracks;
}

async function createDeezerPlaylist(token, title) {
    const endpoint = `/user/me/playlists?access_token=${encodeURIComponent(token)}`;
    const proxyUrl = `/api/deezer/proxy?path=${encodeURIComponent(endpoint)}`;

    const res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `title=${encodeURIComponent(title)}`
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Error al crear lista en Deezer');
    return data; // { id: 12345 }
}

async function addTracksToDeezerPlaylist(token, playlistId, trackIds) {
    if (!trackIds || trackIds.length === 0) return;
    const endpoint = `/playlist/${playlistId}/tracks?access_token=${encodeURIComponent(token)}`;
    const proxyUrl = `/api/deezer/proxy?path=${encodeURIComponent(endpoint)}`;

    const res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `songs=${encodeURIComponent(trackIds.join(','))}`
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Error al añadir canciones en Deezer');
    return data;
}

async function searchDeezerTrack(token, rawTitle, defaultArtist = '') {
    const parsed = cleanYouTubeTitle(rawTitle);
    const title = parsed.title || rawTitle;
    const artist = parsed.artist || defaultArtist;

    const cleanT = cleanTitleForSearch(title);
    const cleanA = cleanTitleForSearch(artist);

    if (cleanT && cleanA) {
        try {
            const q = encodeURIComponent(`track:"${cleanT}" artist:"${cleanA}"`);
            const data = await deezerApi(token, `/search?limit=1&q=${q}`);
            if (data?.data?.[0]?.id) return data.data[0].id;
        } catch (e) {}
    }

    try {
        const freeQ = encodeURIComponent(`${cleanT} ${cleanA}`.trim());
        const data2 = await deezerApi(token, `/search?limit=1&q=${freeQ}`);
        if (data2?.data?.[0]?.id) return data2.data[0].id;
    } catch (e) {}

    try {
        const data3 = await deezerApi(token, `/search?limit=1&q=${encodeURIComponent(cleanT)}`);
        return data3?.data?.[0]?.id || null;
    } catch (e) {
        return null;
    }
}

// ==========================================
// 4. Normalización y Limpieza de Títulos
// ==========================================
function cleanYouTubeTitle(rawTitle) {
    if (!rawTitle) return { title: '', artist: '' };

    let str = rawTitle;
    str = str.replace(/\[(official|video|audio|lyrics?|hd|4k|remastered|visualizer|clip|letra).*?\]/gi, '');
    str = str.replace(/\((official|video|audio|lyrics?|hd|4k|remastered|visualizer|clip|letra|version|en vivo).*?\)/gi, '');
    str = str.replace(/\|\s*official\s*(music\s*)?video/gi, '');
    str = str.replace(/ft\.\s*[^()\[\]-]+/gi, '');
    str = str.replace(/feat\.\s*[^()\[\]-]+/gi, '');
    str = str.replace(/\s+/g, ' ').trim();

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

async function searchSpotifyTrack(token, rawTitle, defaultArtist = '', isrc = '') {
    // 0. Búsqueda exacta instantánea por código universal ISRC (si proviene de Deezer u otro catálogo)
    if (isrc) {
        try {
            const resIsrc = await spotifyApi(token, `/search?type=track&limit=1&q=isrc:${encodeURIComponent(isrc)}`);
            if (resIsrc?.tracks?.items?.[0]?.uri) return resIsrc.tracks.items[0].uri;
        } catch (e) {}
    }

    const parsed = cleanYouTubeTitle(rawTitle);
    const title = parsed.title || rawTitle;
    const artist = parsed.artist || defaultArtist;

    if (artist && title) {
        try {
            const cleanT = cleanTitleForSearch(title);
            const cleanA = cleanTitleForSearch(artist);
            const q = encodeURIComponent(`track:"${cleanT}" artist:"${cleanA}"`);
            const res = await spotifyApi(token, `/search?type=track&limit=1&q=${q}`);
            if (res?.tracks?.items?.[0]?.uri) return res.tracks.items[0].uri;
        } catch (e) {}
    }

    try {
        const freeQuery = encodeURIComponent(`${title} ${artist}`.trim());
        const res2 = await spotifyApi(token, `/search?type=track&limit=1&q=${freeQuery}`);
        if (res2?.tracks?.items?.[0]?.uri) return res2.tracks.items[0].uri;
    } catch (e) {}

    try {
        const cleanT = cleanTitleForSearch(title);
        const res3 = await spotifyApi(token, `/search?type=track&limit=1&q=${encodeURIComponent(cleanT)}`);
        return res3?.tracks?.items?.[0]?.uri || null;
    } catch (e) {
        return null;
    }
}

// ==========================================
// 5. Navigation & UI Adapters
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

function updateModeUI() {
    const srcPlat = getSourcePlatform();
    const dstPlat = getDestPlatform();

    // Actualizar botones de origen
    document.querySelectorAll('#source-platform-selector .plat-src-btn').forEach(btn => {
        const plat = btn.getAttribute('data-platform');
        const isSelected = (plat === srcPlat);
        btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        if (isSelected) {
            const borderCol = plat === 'youtube' ? 'border-red-500 bg-red-500/10' : (plat === 'deezer' ? 'border-purple-500 bg-purple-500/10' : 'border-spotify-green bg-spotify-green/10');
            btn.className = `plat-src-btn p-3 rounded-xl border-2 ${borderCol} text-center transition flex flex-col items-center justify-center gap-1.5 shadow-md`;
        } else {
            btn.className = `plat-src-btn p-3 rounded-xl border border-spotify-border bg-spotify-card/40 text-center transition flex flex-col items-center justify-center gap-1.5 opacity-70 hover:opacity-100 hover:border-gray-500`;
        }
    });

    // Actualizar botones de destino
    document.querySelectorAll('#dest-platform-selector .plat-dst-btn').forEach(btn => {
        const plat = btn.getAttribute('data-platform');
        const isSelected = (plat === dstPlat);
        btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        if (isSelected) {
            const borderCol = plat === 'youtube' ? 'border-red-500 bg-red-500/10' : (plat === 'deezer' ? 'border-purple-500 bg-purple-500/10' : 'border-spotify-green bg-spotify-green/10');
            btn.className = `plat-dst-btn p-3 rounded-xl border-2 ${borderCol} text-center transition flex flex-col items-center justify-center gap-1.5 shadow-md`;
        } else {
            btn.className = `plat-dst-btn p-3 rounded-xl border border-spotify-border bg-spotify-card/40 text-center transition flex flex-col items-center justify-center gap-1.5 opacity-70 hover:opacity-100 hover:border-gray-500`;
        }
    });

    // Badge de ruta activa
    const routeBadge = document.getElementById('active-route-badge');
    if (routeBadge) {
        routeBadge.innerHTML = `${getPlatformIcon(srcPlat)} ${getPlatformName(srcPlat)} ➔ ${getPlatformIcon(dstPlat)} ${getPlatformName(dstPlat)}`;
    }

    // Mostrar/ocultar inputs y guías según plataformas requeridas
    const needsSpot = srcPlat === 'spotify' || dstPlat === 'spotify';
    const needsGoogle = srcPlat === 'youtube' || dstPlat === 'youtube';
    const needsDeezer = srcPlat === 'deezer' || dstPlat === 'deezer';

    const fieldSpot = document.getElementById('field-spotify-client-id');
    const fieldGoogle = document.getElementById('field-google-client-id');
    const fieldDeezer = document.getElementById('field-deezer-credentials');
    const guideSpot = document.getElementById('guide-spotify');
    const guideGoogle = document.getElementById('guide-youtube');
    const guideDeezer = document.getElementById('guide-deezer');

    if (fieldSpot) fieldSpot.style.display = needsSpot ? 'block' : 'none';
    if (fieldGoogle) fieldGoogle.style.display = needsGoogle ? 'block' : 'none';
    if (fieldDeezer) fieldDeezer.style.display = needsDeezer ? 'block' : 'none';
    if (guideSpot) guideSpot.style.display = needsSpot ? 'block' : 'none';
    if (guideGoogle) guideGoogle.style.display = needsGoogle ? 'block' : 'none';
    if (guideDeezer) guideDeezer.style.display = needsDeezer ? 'block' : 'none';

    // Etiquetas del Stepper
    const stepLabel2 = document.getElementById('step-label-2');
    const stepLabel3 = document.getElementById('step-label-3');
    if (stepLabel2) stepLabel2.textContent = `Origen (${getPlatformName(srcPlat)})`;
    if (stepLabel3) stepLabel3.textContent = `Destino (${getPlatformName(dstPlat)})`;
}

function updateStep2UI() {
    const srcPlat = getSourcePlatform();
    const badge = document.getElementById('source-platform-badge');
    const btnLogin = document.getElementById('btn-login-source');
    const profile = getSourceProfile();
    const token = getSourceToken();

    if (srcPlat === 'deezer') {
        if (badge) {
            badge.textContent = 'Cuenta de Origen: Deezer';
            badge.className = 'text-xs uppercase tracking-wider text-purple-400 font-semibold';
        }
        if (btnLogin) {
            btnLogin.className = 'bg-purple-600 hover:bg-purple-500 text-white font-bold px-6 py-3 rounded-full transition flex items-center gap-2 shadow-lg shadow-purple-600/20';
            btnLogin.textContent = token ? 'Cambiar cuenta de Deezer' : 'Conectar Cuenta de Deezer';
        }
    } else if (srcPlat === 'youtube') {
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

    if (dstPlat === 'deezer') {
        if (badge) {
            badge.textContent = 'Cuenta de Destino: Deezer';
            badge.className = 'text-xs uppercase tracking-wider text-purple-400 font-semibold';
        }
        if (btnLogin) {
            btnLogin.className = 'bg-purple-600 hover:bg-purple-500 text-white font-bold px-6 py-3 rounded-full transition flex items-center gap-2 shadow-lg shadow-purple-600/20';
            btnLogin.textContent = token ? 'Cambiar cuenta Deezer destino' : 'Conectar Deezer Destino';
        }
        if (heartBox) heartBox.style.display = 'none';
    } else if (dstPlat === 'youtube') {
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
// 6. Step 1: Configuration Logic
// ==========================================
document.getElementById('redirect-uri-display').textContent = state.redirectUri;

document.getElementById('btn-copy-uri').addEventListener('click', () => {
    navigator.clipboard.writeText(state.redirectUri);
    const btn = document.getElementById('btn-copy-uri');
    const oldText = btn.textContent;
    btn.textContent = '¡Copiado!';
    setTimeout(() => { btn.textContent = oldText; }, 2000);
});

// Selectores dinámicos de plataforma
document.querySelectorAll('#source-platform-selector .plat-src-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        state.sourcePlatform = btn.getAttribute('data-platform');
        localStorage.setItem('source_platform', state.sourcePlatform);
        updateModeUI();
    });
});

document.querySelectorAll('#dest-platform-selector .plat-dst-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        state.destPlatform = btn.getAttribute('data-platform');
        localStorage.setItem('dest_platform', state.destPlatform);
        updateModeUI();
    });
});

// Precarga de valores
if (state.clientId) document.getElementById('input-client-id').value = state.clientId;
if (state.googleClientId) document.getElementById('input-google-client-id').value = state.googleClientId;
if (state.googleClientSecret) document.getElementById('input-google-client-secret').value = state.googleClientSecret;
if (state.deezerAppId) document.getElementById('input-deezer-app-id').value = state.deezerAppId;
if (state.deezerSecret) document.getElementById('input-deezer-secret').value = state.deezerSecret;
updateModeUI();

// Botón principal de Continuar en Paso 1 (1-Click)
const btnProceed = document.getElementById('btn-proceed-step-1');
if (btnProceed) {
    btnProceed.addEventListener('click', () => {
        localStorage.setItem('source_platform', state.sourcePlatform);
        localStorage.setItem('dest_platform', state.destPlatform);
        setStep(2);
    });
}

// Guardado de claves personalizadas desde el panel opcional
document.getElementById('form-config').addEventListener('submit', (e) => {
    e.preventDefault();

    const spotId = document.getElementById('input-client-id').value.trim();
    const googleId = document.getElementById('input-google-client-id').value.trim();
    const googleSec = document.getElementById('input-google-client-secret')?.value.trim() || '';
    const deezerId = document.getElementById('input-deezer-app-id')?.value.trim() || '';
    const deezerSec = document.getElementById('input-deezer-secret')?.value.trim() || '';

    if (spotId) {
        state.clientId = spotId;
        localStorage.setItem('spot_client_id', spotId);
    }
    if (googleId) {
        state.googleClientId = googleId;
        localStorage.setItem('google_client_id', googleId);
    }
    if (googleSec) {
        state.googleClientSecret = googleSec;
        localStorage.setItem('google_client_secret', googleSec);
    }
    if (deezerId) {
        state.deezerAppId = deezerId;
        localStorage.setItem('deezer_app_id', deezerId);
    }
    if (deezerSec) {
        state.deezerSecret = deezerSec;
        localStorage.setItem('deezer_secret', deezerSec);
    }

    const btn = document.getElementById('btn-save-custom-keys');
    if (btn) {
        const oldText = btn.textContent;
        btn.textContent = '✔ Claves guardadas en navegador';
        setTimeout(() => { btn.textContent = oldText; }, 2500);
    }
});

// ==========================================
// 7. Step 2: Source Account Logic
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
        if (srcPlat === 'deezer') {
            // Deezer Flow
            const profile = await loadDeezerProfile(token);
            state.deezerSourceProfile = profile;
            sessionStorage.setItem('deezer_source_profile', JSON.stringify(profile));

            document.getElementById('source-name').textContent = profile.name || `ID: ${profile.id}`;
            document.getElementById('source-email').textContent = profile.email || `ID: ${profile.id}`;
            if (profile.picture) {
                document.getElementById('source-avatar').innerHTML = `<img src="${escapeHtml(profile.picture)}" class="w-full h-full object-cover rounded-full" alt="avatar">`;
            }
            sourceBtn.innerHTML = 'Cambiar cuenta Deezer origen';
            document.getElementById('source-content').classList.remove('hidden');

            const dzPlaylists = await loadDeezerPlaylists(token);
            state.playlists = [];

            // Añadir canciones favoritas de Deezer como primera lista
            try {
                const favRes = await deezerApi(token, '/user/me/tracks?limit=1');
                if (favRes && favRes.total > 0) {
                    state.playlists.push({
                        id: '__LIKED_SONGS__',
                        name: '❤️ Canciones favoritas (Deezer Favorites)',
                        description: 'Tus canciones favoritas guardadas en tu biblioteca de Deezer',
                        tracksCount: favRes.total,
                        imageUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23a238ff"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
                        platform: 'deezer',
                        isLikedSongs: true,
                        isOwned: true,
                        selected: true,
                        tracks: []
                    });
                }
            } catch (e) {
                console.warn('No se pudieron obtener favoritos de Deezer:', e);
            }

            dzPlaylists.forEach(pl => {
                state.playlists.push({
                    id: pl.id,
                    name: pl.title || 'Sin título',
                    description: pl.description || '',
                    tracksCount: pl.nb_tracks || 0,
                    imageUrl: pl.picture_medium || pl.picture || '',
                    platform: 'deezer',
                    isLikedSongs: false,
                    isOwned: pl.creator?.id === profile.id,
                    selected: true,
                    tracks: []
                });
            });

        } else if (srcPlat === 'youtube') {
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

            let likedCount = 0;
            try {
                const likedRes = await spotifyApi(token, '/me/tracks?limit=1');
                likedCount = likedRes.total || 0;
            } catch (e) {
                console.warn('No se pudieron obtener me gusta:', e);
            }
            state.likedSongsTotal = likedCount;

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
        sourceBtn.innerHTML = `Conectar ${getPlatformName(srcPlat)} Origen`;

        if (isForbidden(err) && srcPlat === 'spotify') {
            const banner403 = document.getElementById('source-403-banner');
            if (banner403) {
                banner403.classList.remove('hidden');
                banner403.scrollIntoView({ behavior: 'smooth' });
            }
        } else {
            alert(`Error al conectar con la cuenta de origen: ${err.message}`);
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

// Select/Deselect All
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
            if (srcPlat === 'deezer') {
                tracks = await fetchDeezerPlaylistTracks(token, pl.id);
            } else if (srcPlat === 'youtube') {
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
// 8. Step 3: Destination Account Logic
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
        if (dstPlat === 'deezer') {
            const profile = await loadDeezerProfile(token);
            state.deezerDestProfile = profile;
            sessionStorage.setItem('deezer_dest_profile', JSON.stringify(profile));

            document.getElementById('dest-name').textContent = profile.name || `ID: ${profile.id}`;
            document.getElementById('dest-email').textContent = profile.email || `ID: ${profile.id}`;
            if (profile.picture) {
                document.getElementById('dest-avatar').innerHTML = `<img src="${escapeHtml(profile.picture)}" class="w-full h-full object-cover rounded-full" alt="avatar">`;
            }
            document.getElementById('btn-login-dest').textContent = 'Cambiar cuenta Deezer destino';

        } else if (dstPlat === 'youtube') {
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
        if (dstPlat === 'deezer') {
            state.deezerDestToken = '';
            sessionStorage.removeItem('deezer_dest_token');
        } else if (dstPlat === 'youtube') {
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
            alert(`Error al verificar cuenta de destino: ${err.message}`);
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
        alert('No tienes ninguna playlist seleccionada para transferir. Vuelve al Paso 2.');
        setStep(2);
        return;
    }

    const srcProfile = getSourceProfile();
    const dstProfile = getDestProfile();
    if (getSourcePlatform() === getDestPlatform() && srcProfile && dstProfile && srcProfile.id === dstProfile.id) {
        if (!confirm('⚠️ Advertencia: Ambas cuentas tienen el mismo ID. ¿Deseas duplicar las listas en la misma cuenta?')) {
            return;
        }
    }

    executeTransfer();
});

// ==========================================
// 9. Step 4 & 5: Universal Transfer Engine
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

// Universal Transfer Engine Execution
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

    const routeLabel = `${getPlatformIcon(srcPlat)} ${getPlatformName(srcPlat).toUpperCase()} ➔ ${getPlatformIcon(dstPlat)} ${getPlatformName(dstPlat).toUpperCase()}`;
    logMessage(`🚀 Comenzando transferencia [${routeLabel}] de ${selectedPlaylists.length} listas...`);

    // Perfil destino Spotify si aplica
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
            currentTask.textContent = `[${i + 1}/${selectedPlaylists.length}] "${pl.name}"`;
            statStatus.textContent = `Procesando: ${pl.name}`;
            logMessage(`📂 [${i + 1}/${selectedPlaylists.length}] Procesando lista: <strong>${escapeHtml(pl.name)}</strong>...`);

            // ==========================================
            // PASO A: Obtener canciones de la plataforma origen
            // ==========================================
            let tracks = [];
            if (Array.isArray(pl.tracks) && pl.tracks.length > 0) {
                logMessage(`  └ Usando ${pl.tracks.length} canciones cargadas del respaldo JSON.`);
                tracks = pl.tracks;
            } else if (srcPlat === 'deezer') {
                if (pl.isLikedSongs) {
                    tracks = await fetchDeezerFavoriteTracks(srcToken);
                    logMessage(`  ✔ Obtenidas ${tracks.length} canciones favoritas de Deezer.`);
                } else {
                    tracks = await fetchDeezerPlaylistTracks(srcToken, pl.id);
                    logMessage(`  ✔ Obtenidas ${tracks.length} canciones de Deezer.`);
                }
            } else if (srcPlat === 'youtube') {
                tracks = await fetchYouTubePlaylistTracks(srcToken, pl.id);
                logMessage(`  ✔ Obtenidos ${tracks.length} videos de YouTube.`);
            } else {
                // Spotify
                if (pl.isLikedSongs) {
                    tracks = await fetchLikedSongsTracks(srcToken);
                    logMessage(`  ✔ Obtenidas ${tracks.length} canciones de Tus Me Gusta.`);
                } else {
                    tracks = await fetchPlaylistTracks(srcToken, pl.id);
                    logMessage(`  ✔ Obtenidas ${tracks.length} canciones de Spotify.`);
                }
            }

            // ==========================================
            // PASO B: Destino DEEZER
            // ==========================================
            if (dstPlat === 'deezer') {
                const createPlName = pl.isLikedSongs ? 'Mis Me Gusta (Migrados)' : pl.name;
                logMessage(`  🛠 Creando playlist en Deezer: <strong>${escapeHtml(createPlName)}</strong>...`);

                const newDzPl = await createDeezerPlaylist(dstToken, createPlName);
                const dzPlaylistId = newDzPl.id;
                const matchedTrackIds = [];

                for (let t = 0; t < tracks.length; t++) {
                    const track = tracks[t];
                    let deezerId = track.id && srcPlat === 'deezer' ? track.id : null;

                    if (!deezerId) {
                        currentTask.textContent = `Buscando en Deezer: ${track.name} - ${track.artist}`;
                        deezerId = await searchDeezerTrack(dstToken, track.name, track.artist);
                    }

                    if (deezerId) {
                        matchedTrackIds.push(deezerId);
                    } else {
                        logMessage(`  ⚠️ Sin coincidencia en Deezer: ${escapeHtml(track.name)} - ${escapeHtml(track.artist || '')}`);
                    }
                    await sleep(60);
                }

                // Añadir canciones en lotes de 50
                let addedCount = 0;
                for (let b = 0; b < matchedTrackIds.length; b += 50) {
                    const batch = matchedTrackIds.slice(b, b + 50);
                    await addTracksToDeezerPlaylist(dstToken, dzPlaylistId, batch);
                    addedCount += batch.length;
                    totalTracksTransferred += batch.length;
                    statTracks.textContent = totalTracksTransferred;
                    logMessage(`  └ Canciones añadidas a Deezer: ${addedCount} / ${matchedTrackIds.length}`);
                    await sleep(150);
                }

                finalCreatedList.push({
                    name: createPlName,
                    url: `https://www.deezer.com/playlist/${dzPlaylistId}`,
                    tracksCount: addedCount
                });

            // ==========================================
            // PASO C: Destino YOUTUBE MUSIC
            // ==========================================
            } else if (dstPlat === 'youtube') {
                const createPlName = pl.isLikedSongs ? 'Mis Me Gusta (Migrados)' : pl.name;
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
                    await sleep(90);
                }

                logMessage(`  ✅ Añadidos ${addedCount} / ${tracks.length} videos a YouTube Music.`);
                finalCreatedList.push({
                    name: createPlName,
                    url: `https://music.youtube.com/playlist?list=${ytPlaylistId}`,
                    tracksCount: addedCount
                });

            // ==========================================
            // PASO D: Destino SPOTIFY
            // ==========================================
            } else {
                let trackUris = [];

                if (srcPlat === 'spotify') {
                    trackUris = tracks.map(t => t.uri).filter(uri => uri && uri.startsWith('spotify:track:'));
                } else {
                    // Mapear desde Deezer o YouTube a catálogo Spotify
                    logMessage(`  🔍 Emparejando canciones con el catálogo de Spotify...`);
                    for (let t = 0; t < tracks.length; t++) {
                        const tr = tracks[t];
                        currentTask.textContent = `Buscando en Spotify: ${tr.name}`;
                        const uri = await searchSpotifyTrack(dstToken, tr.name, tr.artist, tr.isrc);
                        if (uri) {
                            trackUris.push(uri);
                        } else {
                            logMessage(`  ⚠️ Sin coincidencia en Spotify: ${escapeHtml(tr.name)}`);
                        }
                        await sleep(70);
                    }
                    logMessage(`  ✔ Emparejadas ${trackUris.length} / ${tracks.length} canciones.`);
                }

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

            if (isQuotaExceeded(err)) {
                logMessage(`<span class="text-amber-400 font-bold">🛑 Transferencia pausada por límite de cuota diaria de Google Cloud (10,000 unidades). El progreso completado se ha conservado con éxito.</span>`);
                alert('⚠️ Se ha alcanzado el límite de cuota diaria gratuita de YouTube (10,000 unidades). La transferencia se ha pausado para proteger tu progreso.');
                break;
            }
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

            const safeUrl = (typeof item.url === 'string' && (item.url.startsWith('https://open.spotify.com/') || item.url.startsWith('https://music.youtube.com/') || item.url.startsWith('https://www.youtube.com/') || item.url.startsWith('https://www.deezer.com/')))
                ? item.url
                : '#';

            row.innerHTML = `
                <span class="font-medium text-white truncate mr-2">🎵 ${escapeHtml(item.name)} <span class="text-gray-500">(${Number(item.tracksCount) || 0} canciones)</span></span>
                <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="text-spotify-green hover:underline flex-shrink-0 flex items-center gap-1 font-semibold">
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
// 10. Init & OAuth Callback Handling
// ==========================================
async function init() {
    await loadServerConfig();

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const authError = urlParams.get('error') || urlParams.get('error_reason');

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

        try {
            if (platform === 'deezer') {
                const tokenData = await exchangeDeezerCode(code);
                if (tokenData.access_token) {
                    if (mode === 'source') {
                        state.deezerSourceToken = tokenData.access_token;
                        sessionStorage.setItem('deezer_source_token', tokenData.access_token);
                        setStep(2);
                        await loadSourceProfileAndPlaylists();
                        return;
                    } else {
                        state.deezerDestToken = tokenData.access_token;
                        sessionStorage.setItem('deezer_dest_token', tokenData.access_token);
                        setStep(3);
                        updateDestinationSummary();
                        await checkDestinationProfile();
                        return;
                    }
                } else {
                    throw new Error(tokenData.error?.message || tokenData.error || 'Respuesta no válida de Deezer');
                }

            } else if (platform === 'google') {
                if (!verifier) {
                    alert('No se encontró el código de verificación (PKCE). Por favor vuelve a conectar.');
                    setStep(mode === 'source' ? 2 : 3);
                    return;
                }
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
                if (!verifier) {
                    alert('No se encontró el código de verificación (PKCE). Por favor vuelve a conectar.');
                    setStep(mode === 'source' ? 2 : 3);
                    return;
                }
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
            alert(`Error al autenticar: ${err.message}`);
        }
    }

    // Enrutamiento inicial de vistas
    if (getDestToken() && state.playlists.length > 0) {
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
        setStep(1);
    }
}

init();
