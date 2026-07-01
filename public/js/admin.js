// Estado global de la aplicación de administración
let alertsList = [];
let soundEnabled = false;
let audioContextUnlocked = false;
let intervalId = null;

// Control de reconexion SSE con backoff exponencial
let sseSource = null;
let sseReintento = 0;
let sseTimeoutId = null;
let modoPolling = false;
let pollingIntervalId = null;

// Tiempos de resolución para estadísticas históricas de la sesión
const resolutionTimes = [];

// Inicializar al cargar
document.addEventListener("DOMContentLoaded", () => {
    conectarEventos();
    
    // Iniciar temporizador global para actualizar los contadores de tiempo en pantalla cada segundo
    intervalId = setInterval(actualizarTiemposPantalla, 1000);
});

/**
 * Conecta al canal SSE con reconexion automatica infinita y backoff exponencial.
 * Si SSE falla repetidamente activa polling HTTP como fallback garantizado.
 */
function conectarEventos() {
    // Cerrar conexion anterior si existe
    if (sseSource) {
        sseSource.close();
        sseSource = null;
    }

    actualizarEstadoConexion("conectando");
    console.log(`Conectando SSE... (intento ${sseReintento + 1})`);

    const eventSource = new EventSource("/api/events");
    sseSource = eventSource;

    eventSource.onopen = () => {
        console.log("Conexion SSE establecida.");
        sseReintento = 0;
        actualizarEstadoConexion("online");

        // Si estaba en polling, desactivarlo ahora que SSE funciona
        if (modoPolling) {
            modoPolling = false;
            clearInterval(pollingIntervalId);
            pollingIntervalId = null;
            console.log("Polling desactivado, SSE restaurado.");
        }
    };

    eventSource.onerror = () => {
        console.warn("Error SSE. Programando reconexion...");
        actualizarEstadoConexion("reconectando");
        eventSource.close();
        sseSource = null;
        sseReintento++;

        // Backoff exponencial: 1s, 1.5s, 2.25s... hasta 15s maximo
        const espera = Math.min(1000 * Math.pow(1.5, sseReintento), 15000);
        console.log(`Reconectando en ${Math.round(espera / 1000)}s... (intento ${sseReintento})`);

        // Activar polling de respaldo si SSE lleva 4 fallos seguidos
        if (sseReintento >= 4 && !modoPolling) {
            modoPolling = true;
            console.warn("Activando polling HTTP de respaldo cada 3s.");
            pollingIntervalId = setInterval(fetchAlertasPolling, 3000);
        }

        // Seguir intentando reconectar SSE en paralelo
        clearTimeout(sseTimeoutId);
        sseTimeoutId = setTimeout(conectarEventos, espera);
    };

    // Evento de inicialización con alertas pendientes
    eventSource.addEventListener("initial", (event) => {
        try {
            const data = JSON.parse(event.data);
            alertsList = data;
            renderAlerts();
            actualizarEstadisticas();
        } catch (e) {
            console.error("Error al parsear alertas iniciales: ", e);
        }
    });

    // Evento de alerta nueva
    eventSource.addEventListener("newAlert", (event) => {
        try {
            const alert = JSON.parse(event.data);
            if (!alertsList.some(a => a.id === alert.id)) {
                alertsList.push(alert);
                renderAlerts();
                actualizarEstadisticas();
                reproducirAvisoSonoro(alert);
                document.getElementById("stat-last-alert").textContent = `Mesa ${alert.mesa}`;
            }
        } catch (e) {
            console.error("Error al procesar nueva alerta: ", e);
        }
    });

    // Evento de alerta resuelta
    eventSource.addEventListener("resolveAlert", (event) => {
        try {
            const data = JSON.parse(event.data);
            const alertId = data.id;
            const alerta = alertsList.find(a => a.id === alertId);
            if (alerta) resolutionTimes.push(Date.now() - alerta.timestamp);
            alertsList = alertsList.filter(a => a.id !== alertId);
            renderAlerts();
            actualizarEstadisticas();
        } catch (e) {
            console.error("Error al procesar resolucion de alerta: ", e);
        }
    });
}

/**
 * Polling HTTP de respaldo: consulta /api/alerts cada 3s cuando SSE no funciona.
 */
async function fetchAlertasPolling() {
    try {
        const resp = await fetch("/api/alerts");
        if (!resp.ok) return;
        const data = await resp.json();
        alertsList = data;
        renderAlerts();
        actualizarEstadisticas();
        actualizarEstadoConexion("polling");
    } catch (e) {
        actualizarEstadoConexion("reconectando");
    }
}

/**
 * Actualiza el indicador visual de estado de conexion.
 * @param {"online"|"reconectando"|"conectando"|"polling"} estado
 */
function actualizarEstadoConexion(estado) {
    const statusDot = document.getElementById("connection-status");
    if (!statusDot) return;
    const statusText = statusDot.querySelector(".status-text");
    switch (estado) {
        case "online":
            statusDot.className = "status-indicator status-online";
            statusText.textContent = "Conectado";
            break;
        case "polling":
            statusDot.className = "status-indicator status-online";
            statusText.textContent = "Conectado";
            break;
        case "reconectando":
            statusDot.className = "status-indicator status-reconnecting";
            statusText.textContent = "Reconectando...";
            break;
        case "conectando":
        default:
            statusDot.className = "status-indicator status-offline";
            statusText.textContent = "Conectando...";
            break;
    }
}

/**
 * Dibuja las alertas en el DOM
 */
function renderAlerts() {
    const grid = document.getElementById("alerts-grid");
    const placeholder = document.getElementById("no-alerts-placeholder");
    
    // Guardar el placeholder para no destruirlo
    if (alertsList.length === 0) {
        grid.innerHTML = "";
        grid.appendChild(placeholder);
        placeholder.style.display = "flex";
        return;
    }

    placeholder.style.display = "none";
    
    // Obtener los IDs actuales en el DOM para evitar re-renderizar todo y perder animaciones
    const cardsExistentes = Array.from(grid.querySelectorAll(".alert-card"));
    const idsExistentes = cardsExistentes.map(card => card.getAttribute("data-id"));
    const idsNuevos = alertsList.map(a => a.id);

    // 1. Eliminar tarjetas que ya no están activas
    cardsExistentes.forEach(card => {
        const id = card.getAttribute("data-id");
        if (!idsNuevos.includes(id)) {
            card.style.animation = "card-exit 0.3s cubic-bezier(0.4, 0, 1, 1) forwards";
            setTimeout(() => card.remove(), 300);
        }
    });

    // 2. Añadir u ordenar las tarjetas nuevas
    alertsList.forEach(alert => {
        if (!idsExistentes.includes(alert.id)) {
            const card = crearTarjetaAlerta(alert);
            grid.appendChild(card);
        }
    });
}

/**
 * Crea el elemento DOM para una tarjeta de alerta
 */
function crearTarjetaAlerta(alert) {
    const card = document.createElement("div");
    card.setAttribute("data-id", alert.id);
    card.setAttribute("data-timestamp", alert.timestamp);
    
    // Asignar clase de estilo según tipo
    let tipoClase = "alert-waiter";
    let tipoTexto = "Llamar Camarero";
    let tipoIcono = "fa-bell";

    if (alert.tipo === "pedir") {
        tipoClase = "alert-pedir";
        tipoTexto = "Quiero Pedir";
        tipoIcono = "fa-clipboard-list";
    } else if (alert.tipo === "cuenta") {
        tipoClase = "alert-bill";
        tipoTexto = "Pedir la Cuenta";
        tipoIcono = "fa-credit-card";
    }

    card.className = `alert-card ${tipoClase}`;

    const date = new Date(alert.timestamp);
    const horaFormateada = date.toLocaleTimeString('es-ES', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit' 
    });

    const tiempoTranscurrido = calcularTiempoTranscurrido(alert.timestamp);

    card.innerHTML = `
        <div class="alert-list-left">
            <span class="alert-badge"><i class="fa-solid ${tipoIcono}"></i> ${tipoTexto}</span>
            <div class="mesa-info">
                <span class="mesa-label">Mesa</span>
                <span class="mesa-num-badge">${alert.mesa}</span>
            </div>
        </div>
        <div class="alert-list-middle">
            <span class="alert-desc-text">${obtenerTextoDescriptivo(alert.tipo, alert.mesa)}</span>
        </div>
        <div class="alert-list-right">
            <span class="alert-time-stamp"><i class="fa-regular fa-clock"></i> ${horaFormateada}</span>
            <span class="alert-timer-text">hace <span class="timer-val">${tiempoTranscurrido}</span></span>
        </div>
    `;

    // Comprobar si ya nace como crítica (espera > 5 minutos)
    if (Date.now() - alert.timestamp > 300000) {
        card.classList.add("critical");
    }

    return card;
}

/**
 * Texto descriptivo de la notificacion
 */
function obtenerTextoDescriptivo(tipo, mesa) {
    switch (tipo) {
        case 'pedir':
            return `La mesa está lista para realizar su pedido.`;
        case 'cuenta':
            return `Ha solicitado la cuenta de su mesa.`;
        case 'camarero':
        default:
            return `Necesita atención de un camarero en mesa.`;
    }
}

/**
 * Envia la solicitud de resolucion al servidor al atender la mesa
 */
async function resolverAlerta(id) {
    const card = document.querySelector(`.alert-card[data-id="${id}"]`);
    if (card) {
        const btn = card.querySelector(".resolve-btn");
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Atendiendo...';
    }

    try {
        const response = await fetch("/api/resolve", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ id: id })
        });

        if (!response.ok) {
            throw new Error("No se pudo resolver la alerta en el servidor");
        }
    } catch (e) {
        console.error("Error al resolver alerta: ", e);
        // Restaurar boton en caso de fallo
        if (card) {
            const btn = card.querySelector(".resolve-btn");
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Atendido';
            alert("No se pudo conectar con el servidor para archivar este aviso.");
        }
    }
}

/**
 * Actualiza los contadores de tiempo de espera en pantalla cada segundo sin redibujar
 */
function actualizarTiemposPantalla() {
    const cards = document.querySelectorAll(".alert-card");
    const ahora = Date.now();

    cards.forEach(card => {
        const timestamp = parseInt(card.getAttribute("data-timestamp"));
        const timerVal = card.querySelector(".timer-val");
        
        if (timerVal) {
            timerVal.textContent = calcularTiempoTranscurrido(timestamp);
        }

        // Si la espera supera los 5 minutos (300000 ms), marcar como critica (rojo/parpadeo)
        if (ahora - timestamp > 300000) {
            card.classList.add("critical");
        } else {
            card.classList.remove("critical");
        }
    });

    // Actualizar tambien el promedio dinamicamente si hay alertas activas
    if (alertsList.length > 0) {
        actualizarEstadisticas();
    }
}

/**
 * Calcula la diferencia de tiempo en formato amigable (ej: "45s", "3m 12s", "14m")
 */
function calcularTiempoTranscurrido(timestamp) {
    const diffMs = Date.now() - timestamp;
    const diffSeg = Math.floor(diffMs / 1000);
    
    if (diffSeg < 60) {
        return `${diffSeg}s`;
    }
    
    const diffMin = Math.floor(diffSeg / 60);
    const segRestantes = diffSeg % 60;
    
    if (diffMin < 60) {
        return `${diffMin}m ${segRestantes}s`;
    }
    
    const diffHor = Math.floor(diffMin / 60);
    const minRestantes = diffMin % 60;
    return `${diffHor}h ${minRestantes}m`;
}

/**
 * Actualiza los valores de la barra de estadisticas
 */
function actualizarEstadisticas() {
    // 1. Alertas activas
    document.getElementById("stat-active-count").textContent = alertsList.length;

    // 2. Tiempo promedio de respuesta
    // Calculamos el promedio combinando las ya resueltas en la sesion y las esperas activas
    let sumaTiempos = 0;
    let totalItems = 0;

    // Sumar historico
    resolutionTimes.forEach(t => {
        sumaTiempos += t;
        totalItems++;
    });

    // Sumar activas
    alertsList.forEach(a => {
        sumaTiempos += (Date.now() - a.timestamp);
        totalItems++;
    });

    const avgVal = document.getElementById("stat-avg-time");
    if (totalItems > 0) {
        const avgMs = sumaTiempos / totalItems;
        const avgSeg = Math.floor(avgMs / 1000);
        if (avgSeg < 60) {
            avgVal.textContent = `${avgSeg}s`;
        } else {
            avgVal.textContent = `${Math.floor(avgSeg / 60)}m ${avgSeg % 60}s`;
        }
    } else {
        avgVal.textContent = "--";
    }
}

/**
 * Alterna el estado del sonido activado/desactivado
 */
function toggleSound() {
    const btn = document.getElementById("sound-toggle");
    
    if (soundEnabled) {
        soundEnabled = false;
        btn.className = "control-btn sound-muted";
        btn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i> <span>Sonido Desactivado</span>';
    } else {
        desbloquearAudioContext();
        soundEnabled = true;
        btn.className = "control-btn sound-enabled";
        btn.innerHTML = '<i class="fa-solid fa-volume-high"></i> <span>Sonido Activado</span>';
        
        // Reproducir pequeño tono de confirmacion
        setTimeout(reproducirAvisoSonoro, 100);
    }
}

/**
 * Activa el sonido del navegador y oculta el overlay de seguridad inicial
 */
function enableAudioAndCloseOverlay() {
    desbloquearAudioContext();
    soundEnabled = true;
    
    // Sincronizar boton de la barra
    const btn = document.getElementById("sound-toggle");
    if (btn) {
        btn.className = "control-btn sound-enabled";
        btn.innerHTML = '<i class="fa-solid fa-volume-high"></i> <span>Sonido Activado</span>';
    }

    // Ocultar overlay
    const overlay = document.getElementById("audio-prompt-overlay");
    if (overlay) {
        overlay.style.opacity = "0";
        setTimeout(() => overlay.remove(), 300);
    }

    // Tono de confirmacion
    reproducirAvisoSonoro();
}

/**
 * Inicializa un contexto de audio vacio para cumplir con politicas de reproduccion de navegadores
 */
function desbloquearAudioContext() {
    if (audioContextUnlocked) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        // Crear oscilador silencioso
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(0);
        osc.stop(0.01);
        audioContextUnlocked = true;
        console.log("AudioContext desbloqueado correctamente.");
    } catch (e) {
        console.warn("Fallo al desbloquear AudioContext: ", e);
    }
}

/**
 * Genera un sonido sintético agradable de aviso doble (chime) usando Web Audio API nativo.
 * No requiere descargar archivos externos de internet.
 */
/**
 * Reproduce un aviso hablado en español mediante la API de SpeechSynthesis del navegador.
 * Dinámicamente anuncia el número de mesa y la acción correspondiente.
 */
function reproducirAvisoSonoro(alert) {
    if (!soundEnabled) return;

    // Si no se proporciona alerta (test de activación)
    if (!alert) {
        try {
            const utterance = new SpeechSynthesisUtterance("Avisos por voz activados");
            utterance.lang = "es-ES";
            window.speechSynthesis.speak(utterance);
        } catch (e) {
            reproducirTonoRespaldo();
        }
        return;
    }

    try {
        let texto = `Mesa ${alert.mesa} solicita atención`;
        if (alert.tipo === "pedir") {
            texto = `Mesa ${alert.mesa} va a pedir`;
        } else if (alert.tipo === "camarero") {
            texto = `Mesa ${alert.mesa} llama al camarero`;
        } else if (alert.tipo === "cuenta") {
            texto = `Mesa ${alert.mesa} pide la cuenta`;
        }

        const utterance = new SpeechSynthesisUtterance(texto);
        utterance.lang = "es-ES";

        // Intentar seleccionar una voz en español si está disponible
        const voices = window.speechSynthesis.getVoices();
        const spanishVoice = voices.find(v => v.lang.startsWith("es"));
        if (spanishVoice) {
            utterance.voice = spanishVoice;
        }

        window.speechSynthesis.speak(utterance);
    } catch (e) {
        console.warn("Fallo en síntesis de voz, usando tono acústico de respaldo:", e);
        reproducirTonoRespaldo();
    }
}

/**
 * Genera un tono sintetizado clásico (chime) como respaldo si la voz falla.
 */
function reproducirTonoRespaldo() {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContextClass();
        const now = ctx.currentTime;

        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = "sine";
        osc1.frequency.setValueAtTime(783.99, now); // Sol5
        gain1.gain.setValueAtTime(0, now);
        gain1.gain.linearRampToValueAtTime(0.15, now + 0.04);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.35);

        const delay = 0.12;
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = "sine";
        osc2.frequency.setValueAtTime(987.77, now + delay); // Si5
        gain2.gain.setValueAtTime(0, now + delay);
        gain2.gain.linearRampToValueAtTime(0.15, now + delay + 0.04);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.45);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + delay);
        osc2.stop(now + delay + 0.45);
    } catch (err) {
        console.error("No se pudo reproducir audio de respaldo:", err);
    }
}
