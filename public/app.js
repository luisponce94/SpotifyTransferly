/**
 * ====================================================================
 * SpotifyTransferly - Motor de Migración de Playlists entre Cuentas
 * ====================================================================
 * ¿CÓMO FUNCIONA LA TRANSFERENCIA EXACTAMENTE?
 * 
 * 1. AUTENTICACIÓN PKCE (OAuth 2.0 sin Client Secret):
 *    - La app genera un `code_verifier` aleatorio de 64 caracteres y obtiene
 *      su hash SHA-256 (`code_challenge`).
 *    - Spotify autoriza al usuario y devuelve un código temporal que se intercambia
 *      vía el proxy local (/api/token) por un `access_token` y `refresh_token`.
 * 
 * 2. GESTIÓN DUAL DE CUENTAS (Origen vs Destino):
 *    - Cuenta Origen: Se obtienen las playlists, me gusta y sus canciones (URIs).
 *    - Cuenta Destino: Se crea una nueva playlist o se guardan las canciones.
 *    - Ambos tokens se mantienen aislados en `sessionStorage` para operar en paralelo.
 * 
 * 3. MOTOR DE TRANSFERENCIA (Dual-Route):
 *    - Playlists Propias: Lee las canciones en lotes de 100 de origen, crea la lista
 *      en destino y añade las canciones por bloques para no saturar la API.
 *    - Playlists Públicas/Terceros: Se guardan directamente en la biblioteca del destino
 *      usando followers o el endpoint de biblioteca.
 *    - Canciones que te gustan (Liked Songs): Se transfieren marcándolas con corazón ❤️
 *      usando PUT /v1/me/tracks en lotes de 50.
 *    - Respaldo JSON: Permite exportar/importar listas completas sin necesidad de
 *      tener acceso simultáneo a la cuenta de origen.
 *    - Resiliencia: Control de HTTP 429 (Retry-After) y renovación automática ante 401.
 * ====================================================================
 */

// SpotTransfer - Client-side App Logic

// Enforce 127.0.0.1 to maintain identical localStorage across redirects
if (window.location.hostname === 'localhost') {
    window.location.replace(window.location.href.replace('localhost', '127.0.0.1'));
}

// Estado de la interfaz. Los tokens sensibles se guardan en sessionStorage (se destruyen al cerrar la pestaña).
// Global State
const currentPort = window.location.port ? `:${window.location.port}` : '';
const state = {
    step: 1,
    clientId: localStorage.getItem('spot_client_id') || '',
    redirectUri: `${window.location.protocol}//127.0.0.1${currentPort}/callback`,
    sourceToken: sessionStorage.getItem('spot_source_token') || localStorage.getItem('spot_source_token') || '',
    sourceRefreshToken: sessionStorage.getItem('spot_source_refresh_token') || localStorage.getItem('spot_source_refresh_token') || '',
    sourceProfile: JSON.parse(sessionStorage.getItem('spot_source_profile') || localStorage.getItem('spot_source_profile') || 'null'),
    destToken: sessionStorage.getItem('spot_dest_token') || localStorage.getItem('spot_dest_token') || '',
    destRefreshToken: sessionStorage.getItem('spot_dest_refresh_token') || localStorage.getItem('spot_dest_refresh_token') || '',
    destProfile: JSON.parse(sessionStorage.getItem('spot_dest_profile') || localStorage.getItem('spot_dest_profile') || 'null'),
    playlists: JSON.parse(localStorage.getItem('spot_playlists') || '[]'),
    likedSongsTotal: parseInt(localStorage.getItem('spot_liked_total') || '0', 10),
    isTransferring: false
};

// Migrar tokens existentes de localStorage a sessionStorage por seguridad
localStorage.removeItem('spot_source_token');
localStorage.removeItem('spot_dest_token');
localStorage.removeItem('spot_source_refresh_token');
localStorage.removeItem('spot_dest_refresh_token');
if (state.sourceToken) sessionStorage.setItem('spot_source_token', state.sourceToken);
if (state.sourceRefreshToken) sessionStorage.setItem('spot_source_refresh_token', state.sourceRefreshToken);
if (state.destToken) sessionStorage.setItem('spot_dest_token', state.destToken);
if (state.destRefreshToken) sessionStorage.setItem('spot_dest_refresh_token', state.destRefreshToken);

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
    return msg.includes('403') || msg.includes('forbidden') || msg.includes('not registered');
}

// Escapar texto externo antes de insertarlo en plantillas HTML.
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

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

// Helper: Sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// Start Spotify OAuth PKCE Flow
async function initiateAuth(mode) {
    if (!state.clientId) {
        alert('Por favor configura primero tu Client ID.');
        setStep(1);
        return;
    }

    savePlaylists();

    const verifier = generateRandomString(64);
    const hashed = await sha256(verifier);
    const challenge = base64UrlEncode(hashed);

    // Vincula la respuesta OAuth con esta solicitud para evitar callbacks ajenos.
    const oauthState = generateRandomString(32);
    sessionStorage.setItem('spot_oauth_state', oauthState);
    localStorage.setItem('spot_auth_mode', mode);
    localStorage.setItem('spot_code_verifier', verifier);

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

// Exchange authorization code for access token via local proxy
async function exchangeCode(code, verifier) {
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

// Renovar access_token con refresh_token
async function refreshAccessToken(mode) {
    const refreshToken = mode === 'source' ? state.sourceRefreshToken : state.destRefreshToken;
    if (!refreshToken) throw new Error(`No hay refresh token disponible para la cuenta de ${mode === 'source' ? 'origen' : 'destino'}.`);

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
    throw new Error(tokenData.error_description || tokenData.error || 'No se pudo renovar la sesión de Spotify');
}

// Authenticated Spotify API caller with rate limit retry & refresh token support
async function spotifyApi(token, endpoint, options = {}) {
    const url = new URL(endpoint.startsWith('http') ? endpoint : `https://api.spotify.com/v1${endpoint}`);
    // Nunca enviar el Bearer token a un host indicado por datos externos.
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

            if (res.status === 204) {
                return null;
            }

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
                            logMessage(`[Sesión] Renovando token expirado de cuenta de ${mode === 'source' ? 'origen' : 'destino'}...`);
                            const newToken = await refreshAccessToken(mode);
                            return await spotifyApi(newToken, endpoint, { ...options, _isRetryAfterRefresh: true });
                        } catch (refreshErr) {
                            console.warn('Error al auto-renovar token:', refreshErr);
                        }
                    }
                }

                // Errores deterministas de cliente: no reintentar en bucle
                if ([400, 401, 403, 404].includes(res.status)) {
                    throw err;
                }
                throw err;
            }

            if (!text || text.trim().length === 0) {
                return null;
            }

            try {
                return JSON.parse(text);
            } catch (e) {
                return text;
            }
        } catch (err) {
            // Si es un error de cliente permanente ya lanzado, propagar de inmediato
            if (err.status && [400, 401, 403, 404].includes(err.status)) {
                throw err;
            }
            if (attempts >= 5) throw err;
            await sleep(1000 * attempts);
        }
    }
}

// ==========================================
// 2. Navigation & Stepper
// ==========================================
function setStep(stepNumber) {
    state.step = stepNumber;
    localStorage.setItem('spot_step', stepNumber);

    Object.values(views).forEach(v => v.classList.add('hidden'));

    if (views[`step${stepNumber}`]) {
        views[`step${stepNumber}`].classList.remove('hidden');
    }

    if (stepNumber === 3) {
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

// ==========================================
// 3. Step 1: Configuration Logic
// ==========================================
document.getElementById('redirect-uri-display').textContent = state.redirectUri;

document.getElementById('btn-copy-uri').addEventListener('click', () => {
    navigator.clipboard.writeText(state.redirectUri);
    const btn = document.getElementById('btn-copy-uri');
    const oldText = btn.textContent;
    btn.textContent = '¡Copiado!';
    setTimeout(() => { btn.textContent = oldText; }, 2000);
});

if (state.clientId) {
    document.getElementById('input-client-id').value = state.clientId;
}

document.getElementById('form-config').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('input-client-id').value.trim();
    if (!id) return;
    state.clientId = id;
    localStorage.setItem('spot_client_id', id);
    setStep(2);
});

// ==========================================
// 4. Step 2: Source Account Logic
// ==========================================
document.getElementById('btn-login-source').addEventListener('click', () => {
    const banner403 = document.getElementById('source-403-banner');
    if (banner403) banner403.classList.add('hidden');
    initiateAuth('source');
});

async function loadSourceProfileAndPlaylists() {
    if (!state.sourceToken) return;

    const sourceBtn = document.getElementById('btn-login-source');
    sourceBtn.innerHTML = `⏳ Cargando datos...`;

    try {
        const profile = await spotifyApi(state.sourceToken, '/me');
        state.sourceProfile = profile;
        localStorage.setItem('spot_source_profile', JSON.stringify(profile));

        document.getElementById('source-name').textContent = profile.display_name || profile.id;
        document.getElementById('source-email').textContent = profile.email || `ID: ${profile.id}`;
        if (profile.images && profile.images.length > 0) {
            document.getElementById('source-avatar').innerHTML = `<img src="${escapeHtml(profile.images[0].url)}" class="w-full h-full object-cover rounded-full" alt="avatar">`;
        }
        sourceBtn.innerHTML = 'Cambiar cuenta origen';
        document.getElementById('source-content').classList.remove('hidden');

        // Fetch Liked Songs count
        let likedCount = 0;
        try {
            const likedRes = await spotifyApi(state.sourceToken, '/me/tracks?limit=1');
            likedCount = likedRes.total || 0;
        } catch (e) {
            console.warn('No se pudieron obtener me gusta:', e);
        }
        state.likedSongsTotal = likedCount;

        // Fetch All Playlists
        let playlists = [];
        let url = '/me/playlists?limit=50';
        while (url) {
            const data = await spotifyApi(state.sourceToken, url);
            if (data && data.items) {
                playlists = playlists.concat(data.items);
                url = data.next;
            } else {
                break;
            }
        }

        state.playlists = [];

        // Special: Add Liked Songs as virtual playlist #1 if > 0
        if (state.likedSongsTotal > 0) {
            state.playlists.push({
                id: '__LIKED_SONGS__',
                name: '❤️ Canciones que te gustan (Liked Songs)',
                description: 'Tus canciones favoritas guardadas en tu biblioteca',
                tracksCount: state.likedSongsTotal,
                imageUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%231ed760"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
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
                isLikedSongs: false,
                isOwned: isOwned,
                selected: true,
                tracks: []
            });
        });

        savePlaylists();
        renderPlaylists();
    } catch (err) {
        console.error('Error cargando origen:', err);
        sourceBtn.innerHTML = 'Conectar Cuenta de Origen';

        if (isForbidden(err)) {
            const banner403 = document.getElementById('source-403-banner');
            if (banner403) {
                banner403.classList.remove('hidden');
                banner403.scrollIntoView({ behavior: 'smooth' });
            }
        } else if (err.message && (err.message.includes('401') || err.message.includes('expired'))) {
            state.sourceToken = '';
            state.sourceRefreshToken = '';
            sessionStorage.removeItem('spot_source_token');
            sessionStorage.removeItem('spot_source_refresh_token');
            localStorage.removeItem('spot_source_token');
            alert('Tu sesión de Spotify expiró. Por favor vuelve a hacer clic en "Conectar Cuenta de Origen".');
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

    const exportData = [];
    for (const pl of selected) {
        let trackUris = [];
        try {
            if (pl.isLikedSongs) {
                trackUris = await fetchLikedSongsTracks(state.sourceToken);
            } else if (pl.isOwned) {
                trackUris = await fetchPlaylistTracks(state.sourceToken, pl.id);
            }
        } catch (e) {
            console.warn(`No se pudieron exportar pistas de ${escapeHtml(pl.name)}:`, e);
        }
        exportData.push({
            name: pl.name,
            id: pl.id,
            description: pl.description,
            isLikedSongs: pl.isLikedSongs,
            isOwned: pl.isOwned,
            tracks: trackUris
        });
    }

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spottransfer-backup-${new Date().toISOString().split('T')[0]}.json`;
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
// 5. Step 3: Destination Account Logic
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
    if (!state.destToken) return;

    try {
        const profile = await spotifyApi(state.destToken, '/me');
        state.destProfile = profile;
        localStorage.setItem('spot_dest_profile', JSON.stringify(profile));

        document.getElementById('dest-name').textContent = profile.display_name || profile.id;
        document.getElementById('dest-email').textContent = profile.email || `ID: ${profile.id}`;
        if (profile.images && profile.images.length > 0) {
            document.getElementById('dest-avatar').innerHTML = `<img src="${escapeHtml(profile.images[0].url)}" class="w-full h-full object-cover rounded-full" alt="avatar">`;
        }
        document.getElementById('btn-login-dest').textContent = 'Cambiar cuenta destino';

        // Check if same account
        const warning = document.getElementById('warning-same-account');
        if (state.sourceProfile && state.destProfile && state.sourceProfile.id === state.destProfile.id) {
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
        state.destToken = '';
        state.destRefreshToken = '';
        sessionStorage.removeItem('spot_dest_token');
        sessionStorage.removeItem('spot_dest_refresh_token');
        localStorage.removeItem('spot_dest_token');

        if (isForbidden(err)) {
            const banner403 = document.getElementById('dest-403-banner');
            if (banner403) banner403.classList.remove('hidden');
            alert('⚠️ Error 403: Tu cuenta de DESTINO no está registrada en "Users and Access" de tu Spotify Developer Dashboard. Agrega su correo y pulsa Save.');
        } else {
            alert('Error al verificar cuenta de destino: ' + err.message);
        }
    }
}

// Start transfer
document.getElementById('btn-start-transfer').addEventListener('click', () => {
    if (!state.destToken) {
        alert('Por favor conecta primero tu Cuenta de Destino.');
        return;
    }

    const selectedPlaylists = state.playlists.filter(p => p.selected);
    if (selectedPlaylists.length === 0) {
        alert('No tienes ninguna playlist seleccionada para transferir. Vuelve al Paso 2 y selecciona tus listas.');
        setStep(2);
        return;
    }

    if (state.sourceProfile && state.destProfile && state.sourceProfile.id === state.destProfile.id) {
        if (!confirm('⚠️ Advertencia: Ambas cuentas tienen el mismo ID. ¿Estás seguro de que deseas duplicar las listas en la misma cuenta?')) {
            return;
        }
    }

    executeTransfer();
});

// ==========================================
// 6. Step 4 & 5: Transfer Engine (Dual-Route)
// ==========================================
function logMessage(msg) {
    const consoleBox = document.getElementById('live-console');
    const time = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.innerHTML = `<span class="text-gray-500">[${time}]</span> ${msg}`;
    consoleBox.appendChild(line);
    consoleBox.scrollTop = consoleBox.scrollHeight;
}

// Fetch tracks helper for owned playlist
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
        // Fallback to legacy endpoint if items is 404
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

// Fetch tracks helper for Liked Songs
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

// Create a new playlist on destination user
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

// Add tracks to playlist
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

// Save tracks with heart ❤️ to destination library using standard /me/tracks
async function saveLikedTracksToLibrary(token, trackUris) {
    if (!trackUris || trackUris.length === 0) return 0;

    let saved = 0;
    const batchSize = 50; // Límite oficial de Spotify para PUT /me/tracks

    for (let b = 0; b < trackUris.length; b += batchSize) {
        const batch = trackUris.slice(b, b + batchSize);
        const ids = batch.map(u => u.split(':').pop()).filter(Boolean);

        let success = false;
        // 1. Endpoint estándar y probado de Spotify: PUT /me/tracks con JSON body
        try {
            await spotifyApi(token, `/me/tracks`, {
                method: 'PUT',
                body: JSON.stringify({ ids: ids })
            });
            success = true;
        } catch (tracksErr) {
            console.warn('PUT /me/tracks falló, probando fallback a /me/library:', tracksErr);
            // 2. Fallback a /me/library?uris=...
            try {
                const urisParam = encodeURIComponent(batch.join(','));
                await spotifyApi(token, `/me/library?uris=${urisParam}`, {
                    method: 'PUT'
                });
                success = true;
            } catch (libErr) {
                throw tracksErr;
            }
        }

        if (success) {
            saved += batch.length;
            logMessage(`  └ Corazones guardados: ${saved} / ${trackUris.length}`);
        }
        await sleep(150);
    }
    return saved;
}

// Save/follow a public/editorial playlist directly to destination library
async function savePlaylistToDestinationLibrary(token, playlistId) {
    // 1. Try legacy /followers (proven universal compatibility)
    try {
        await spotifyApi(token, `/playlists/${encodeURIComponent(playlistId)}/followers`, {
            method: 'PUT',
            body: JSON.stringify({ public: false })
        });
        return true;
    } catch (e) {
        console.warn('Followers falló, probando /me/library:', e);
    }

    // 2. Try modern /me/library
    try {
        await spotifyApi(token, `/me/library?uris=spotify:playlist:${encodeURIComponent(playlistId)}`, {
            method: 'PUT'
        });
        return true;
    } catch (e) {
        console.warn('me/library falló:', e);
        throw e;
    }
}

async function executeTransfer() {
    setStep(4);
    state.isTransferring = true;

    const selectedPlaylists = state.playlists.filter(p => p.selected);
    const isPrivate = document.getElementById('opt-private').checked;
    const heartLikedSongs = document.getElementById('opt-heart-songs').checked;

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
    logMessage(`🚀 Comenzando transferencia de ${selectedPlaylists.length} listas seleccionadas...`);

    // Ensure we have destination profile
    if (!state.destProfile || !state.destProfile.id) {
        try {
            state.destProfile = await spotifyApi(state.destToken, '/me');
        } catch (e) {
            console.warn('No se pudo refrescar perfil destino:', e);
        }
    }
    const destUserId = state.destProfile?.id || '';

    for (let i = 0; i < selectedPlaylists.length; i++) {
        const pl = selectedPlaylists[i];

        try {
            currentTask.textContent = `[${i + 1}/${selectedPlaylists.length}] "${escapeHtml(pl.name)}"`;
            statStatus.textContent = `Procesando: ${escapeHtml(pl.name)}`;

            // Check if playlist is external/public (not owned by user)
            const isExternal = !pl.isLikedSongs && pl.isOwned === false;

            if (isExternal) {
                logMessage(`📂 <strong>${escapeHtml(pl.name)}</strong> es una lista pública/de terceros.`);
                logMessage(`  └ Guardándola directamente en tu nueva biblioteca...`);

                await savePlaylistToDestinationLibrary(state.destToken, pl.id);

                completedPlaylists++;
                statPlaylists.textContent = `${completedPlaylists} / ${selectedPlaylists.length}`;

                finalCreatedList.push({
                    name: pl.name,
                    url: `https://open.spotify.com/playlist/${pl.id}`,
                    tracksCount: pl.tracksCount || 0
                });

                const percentage = Math.round((completedPlaylists / selectedPlaylists.length) * 100);
                progressFill.style.width = `${percentage}%`;
                progressFill.setAttribute('aria-valuenow', percentage);
                progressPercent.textContent = `${percentage}%`;

                logMessage(`✅ Lista <strong>${escapeHtml(pl.name)}</strong> guardada en tu biblioteca.`);
                await sleep(250);
                continue;
            }

            // Normal clone flow for user's own playlists or Liked Songs
            logMessage(`📂 Procesando lista propia: <strong>${escapeHtml(pl.name)}</strong>...`);

            let tracks = [];
            if (Array.isArray(pl.tracks) && pl.tracks.length > 0) {
                // Si la playlist ya contiene canciones (respaldo JSON importado)
                logMessage(`📂 Usando ${pl.tracks.length} canciones cargadas del respaldo JSON para: <strong>${escapeHtml(pl.name)}</strong>`);
                tracks = pl.tracks.map(t => (typeof t === 'string' ? { uri: t } : t));
            } else if (pl.isLikedSongs) {
                tracks = await fetchLikedSongsTracks(state.sourceToken);
                logMessage(`✔ Obtenidas ${tracks.length} canciones de Tus Me Gusta.`);
            } else {
                try {
                    tracks = await fetchPlaylistTracks(state.sourceToken, pl.id);
                    logMessage(`✔ Obtenidas ${tracks.length} canciones.`);
                } catch (readErr) {
                    if (isForbidden(readErr)) {
                        logMessage(`ℹ️ Lectura de pistas restringida por Spotify. Guardándola directamente en tu biblioteca...`);
                        await savePlaylistToDestinationLibrary(state.destToken, pl.id);
                        completedPlaylists++;
                        statPlaylists.textContent = `${completedPlaylists} / ${selectedPlaylists.length}`;
                        finalCreatedList.push({
                            name: pl.name,
                            url: `https://open.spotify.com/playlist/${pl.id}`,
                            tracksCount: pl.tracksCount || 0
                        });
                        logMessage(`✅ Lista guardada en tu biblioteca.`);
                        await sleep(250);
                        continue;
                    }
                    throw readErr;
                }
            }

            // Extract valid Spotify track URIs
            const trackUris = tracks.map(t => t.uri).filter(uri => uri && uri.startsWith('spotify:track:'));

            // Save liked songs with heart
            if (pl.isLikedSongs && heartLikedSongs) {
                currentTask.textContent = `Guardando ${trackUris.length} canciones en tus "Me Gusta"...`;
                logMessage(`❤️ Añadiendo a tus "Canciones que te gustan" con corazón...`);

                try {
                    const heartsSaved = await saveLikedTracksToLibrary(state.destToken, trackUris);
                    logMessage(`✅ ¡${heartsSaved} canciones marcadas con corazón ❤️ en tu biblioteca!`);
                } catch (heartErr) {
                    console.warn('Advertencia guardando corazones:', heartErr);
                    if (isForbidden(heartErr)) {
                        logMessage(`<span class="text-amber-400 font-semibold">⚠️ Permiso denegado para marcar corazones (403 Forbidden).</span>`);
                        logMessage(`<span class="text-amber-300 text-xs block mt-1">💡 <strong>Solución rápida:</strong> Tu sesión de Cuenta Destino se inició antes de autorizar el permiso de biblioteca. Vuelve al Paso 3, haz clic en el botón azul <strong>«Cambiar cuenta destino»</strong> y pulsa «Aceptar» en Spotify para renovar los permisos.</span>`);
                    } else {
                        logMessage(`  ⚠️ Aviso en lote de corazones: ${escapeHtml(heartErr.message)}`);
                    }
                }
            }

            // Create new playlist on destination
            const createPlName = pl.isLikedSongs ? 'Mis Me Gusta (Transferidos)' : pl.name;
            logMessage(`🛠 Creando playlist <strong>${escapeHtml(createPlName)}</strong> en cuenta de destino...`);

            const newPlaylist = await createPlaylistOnDestination(
                state.destToken,
                destUserId,
                createPlName,
                pl.description || 'Migrada exitosamente con SpotTransfer',
                !isPrivate
            );

            if (!newPlaylist || !newPlaylist.id) {
                throw new Error('Spotify no devolvió el ID de la nueva lista.');
            }

            const newPlaylistId = newPlaylist.id;
            finalCreatedList.push({
                name: createPlName,
                url: newPlaylist.external_urls?.spotify || `https://open.spotify.com/playlist/${newPlaylistId}`,
                tracksCount: tracks.length
            });

            // Add tracks in chunks of 100 (only valid Spotify track URIs)
            if (trackUris.length > 0) {
                for (let b = 0; b < trackUris.length; b += 100) {
                    const batch = trackUris.slice(b, b + 100);
                    await addItemsToPlaylist(state.destToken, newPlaylistId, batch);
                    totalTracksTransferred += batch.length;
                    statTracks.textContent = totalTracksTransferred;
                    logMessage(`  └ Canciones añadidas a la lista: ${Math.min(b + 100, trackUris.length)} / ${trackUris.length}`);
                    await sleep(150);
                }
            }

            completedPlaylists++;
            statPlaylists.textContent = `${completedPlaylists} / ${selectedPlaylists.length}`;

            const percentage = Math.round((completedPlaylists / selectedPlaylists.length) * 100);
            progressFill.style.width = `${percentage}%`;
            progressFill.setAttribute('aria-valuenow', percentage);
            progressPercent.textContent = `${percentage}%`;

            logMessage(`✅ Lista <strong>${escapeHtml(createPlName)}</strong> finalizada con éxito.`);
            await sleep(200);

        } catch (err) {
            console.error(`Error transfiriendo lista ${escapeHtml(pl.name)}:`, err);
            logMessage(`<span class="text-red-400">❌ Error al transferir "${escapeHtml(pl.name)}": ${escapeHtml(err.message)}</span>`);

            if (isForbidden(err)) {
                logMessage(`<span class="text-amber-400 font-bold">⚠️ Tu cuenta de DESTINO fue rechazada con 403 Forbidden. Asegúrate de agregar el correo de tu cuenta nueva en "Users and Access" de tu Spotify Developer Dashboard.</span>`);
            }
        }
    }

    statStatus.textContent = '¡Completado!';
    currentTask.textContent = 'Proceso finalizado.';
    logMessage(`🎉 Proceso concluido. Total de listas creadas/guardadas: ${completedPlaylists}.`);

    await sleep(1500);

    // Show Step 5
    document.getElementById('final-playlists-count').textContent = completedPlaylists;
    document.getElementById('final-tracks-count').textContent = totalTracksTransferred;

    const finalListContainer = document.getElementById('final-playlists-list');
    finalListContainer.innerHTML = '';

    if (finalCreatedList.length === 0) {
        finalListContainer.innerHTML = `<div class="text-gray-400 py-3 text-center">No se pudo crear ninguna lista. Revisa los mensajes en la consola en vivo.</div>`;
    } else {
        finalCreatedList.forEach(item => {
            const row = document.createElement('div');
            row.className = 'flex items-center justify-between p-2 rounded-lg bg-spotify-dark/60 border border-spotify-border/60 hover:border-spotify-green transition';
            
            // Validación estricta de esquema para prevenir DOM XSS
            const safeUrl = (typeof item.url === 'string' && (item.url.startsWith('https://open.spotify.com/') || item.url.startsWith('http://127.0.0.1:')))
                ? item.url
                : 'https://open.spotify.com/';

            row.innerHTML = `
                <span class="font-medium text-white truncate mr-2">🎵 ${escapeHtml(item.name)} <span class="text-gray-500">(${Number(item.tracksCount) || 0} tracks)</span></span>
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

// Alerta ante cierre accidental durante transferencia activa
window.addEventListener('beforeunload', (e) => {
    if (state.isTransferring) {
        e.preventDefault();
        e.returnValue = 'Hay una transferencia en curso. Si cierras la ventana, el proceso se interrumpirá.';
    }
});

// Reset button
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
// 7. Init & OAuth Callback Handling
// ==========================================
async function init() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const authError = urlParams.get('error');

    if (authError) {
        alert('Error de autorización en Spotify: ' + authError);
        window.history.replaceState({}, document.title, '/');
    } else if (code) {
        const expectedState = sessionStorage.getItem('spot_oauth_state');
        sessionStorage.removeItem('spot_oauth_state');
        if (!expectedState || urlParams.get('state') !== expectedState) {
            window.history.replaceState({}, document.title, '/');
            alert('La respuesta de autorización no corresponde a esta sesión. Vuelve a conectar tu cuenta.');
            setStep(2);
            return;
        }
        const mode = localStorage.getItem('spot_auth_mode') || 'source';
        const verifier = localStorage.getItem('spot_code_verifier') || '';
        localStorage.removeItem('spot_code_verifier');

        window.history.replaceState({}, document.title, '/');

        if (!verifier) {
            alert('No se encontró el código de verificación (PKCE). Por favor vuelve a hacer clic en Conectar.');
            setStep(2);
            return;
        }

        try {
            const tokenData = await exchangeCode(code, verifier);
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
                } else if (mode === 'destination') {
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
                const errMsg = tokenData.error_description || tokenData.error || 'Respuesta no válida del servidor';
                console.error('Error al obtener token de Spotify.');
                alert(`Error de autenticación con Spotify: ${errMsg}`);
            }
        } catch (err) {
            console.error('Error al intercambiar código:', err);
            alert('Error al autenticar: ' + err.message);
        }
    }

    // Default view routing based on existing state
    if (!state.clientId) {
        setStep(1);
    } else if (state.destToken && state.playlists.length > 0) {
        setStep(3);
        updateDestinationSummary();
        checkDestinationProfile();
    } else if (state.sourceToken) {
        setStep(2);
        if (state.playlists.length > 0) {
            document.getElementById('source-content').classList.remove('hidden');
            renderPlaylists();
            if (state.sourceProfile) {
                document.getElementById('source-name').textContent = state.sourceProfile.display_name || state.sourceProfile.id;
                document.getElementById('source-email').textContent = state.sourceProfile.email || `ID: ${state.sourceProfile.id}`;
            }
        } else {
            loadSourceProfileAndPlaylists();
        }
    } else {
        setStep(2);
    }
}

init();
