// Variables Globales del Estado del Cliente
let mesaNumero = "S/M"; // Sin Mesa por defecto
const COOLDOWN_TIME = 30000; // 30 segundos de cooldown entre llamadas
let enCooldown = false;

// Al cargar el documento
document.addEventListener("DOMContentLoaded", () => {
    inicializarMesa();
    configurarTransicionesMenu();
});

/**
 * Detecta e inicializa el numero de mesa desde los parametros de la URL
 */
function inicializarMesa() {
    const params = new URLSearchParams(window.location.search);
    const mesaParam = params.get("mesa");
    
    if (mesaParam && mesaParam.trim() !== "") {
        mesaNumero = mesaParam.trim();
        const indicator = document.querySelector("#mesa-indicator span");
        if (indicator) {
            indicator.textContent = `Mesa ${mesaNumero}`;
        }
    } else {
        // Si no hay mesa en el query param, intentar buscar en la ruta (ej: /mesa/5)
        const pathParts = window.location.pathname.split('/');
        const indexMesa = pathParts.indexOf('mesa');
        if (indexMesa !== -1 && pathParts[indexMesa + 1]) {
            mesaNumero = pathParts[indexMesa + 1];
            const indicator = document.querySelector("#mesa-indicator span");
            if (indicator) {
                indicator.textContent = `Mesa ${mesaNumero}`;
            }
        } else {
            // Opcional: Mostrar mensaje pidiendo escanear QR
            const indicator = document.querySelector("#mesa-indicator span");
            if (indicator) {
                indicator.textContent = "Escanea el QR de tu mesa";
            }
        }
    }
}

/**
 * Filtra los platos por categoria seleccionada
 */
function filterCategory(category) {
    // Actualizar clase activa en botones
    const buttons = document.querySelectorAll(".category-btn");
    buttons.forEach(btn => btn.classList.remove("active"));
    
    // Buscar boton pulsado
    const clickedBtn = Array.from(buttons).find(btn => 
        btn.getAttribute("onclick").includes(`'${category}'`)
    );
    if (clickedBtn) {
        clickedBtn.classList.add("active");
    }

    // Filtrar secciones del menu
    const sections = document.querySelectorAll(".menu-section");
    sections.forEach(section => {
        const secCat = section.getAttribute("data-category");
        if (category === "todos" || secCat === category) {
            section.style.display = "block";
            // Forzar reflow para transicion de entrada
            setTimeout(() => {
                section.style.opacity = "1";
                section.style.transform = "translateY(0)";
            }, 50);
        } else {
            section.style.opacity = "0";
            section.style.transform = "translateY(10px)";
            // Ocultar despues de la transicion
            setTimeout(() => {
                section.style.display = "none";
            }, 300);
        }
    });
}

/**
 * Configura las transiciones iniciales del menu
 */
function configurarTransicionesMenu() {
    const sections = document.querySelectorAll(".menu-section");
    sections.forEach(sec => {
        sec.style.transition = "opacity 0.3s ease, transform 0.3s ease";
        sec.style.opacity = "1";
        sec.style.transform = "translateY(0)";
    });
}

/**
 * Control del Modal de Servicios
 */
function openServiceModal() {
    if (enCooldown) {
        showToast("Por seguridad, debes esperar un momento antes de llamar de nuevo.", true);
        return;
    }
    const modal = document.getElementById("service-modal");
    modal.classList.add("open");
    document.body.style.overflow = "hidden"; // Desactivar scroll de fondo
}

function closeServiceModal() {
    const modal = document.getElementById("service-modal");
    modal.classList.remove("open");
    document.body.style.overflow = ""; // Reactivar scroll
}

function closeServiceModalOnOverlay(event) {
    if (event.target.id === "service-modal") {
        closeServiceModal();
    }
}

/**
 * Envia una alerta al servidor con reintentos automaticos en caso de fallo de conexion
 * @param {string} tipo - Tipo de alerta ('recomendacion', 'camarero', 'cuenta')
 */
async function sendServiceAlert(tipo) {
    if (enCooldown) return;

    // Si no esta identificado con mesa valida
    if (mesaNumero === "S/M" || mesaNumero.includes("Escanea")) {
        const confirmar = confirm("No hemos detectado tu número de mesa. ¿Quieres enviar el aviso igualmente?");
        if (!confirmar) return;
    }

    const modal = document.getElementById("service-modal");
    const optionButtons = modal.querySelectorAll(".service-option-btn");
    const selectedBtn = modal.querySelector(`.opt-${tipo === 'pedir' ? 'pedir' : tipo === 'camarero' ? 'waiter' : 'bill'}`);

    // Feedback visual inmediato: Deshabilitar botones e indicar carga
    optionButtons.forEach(btn => btn.classList.add("disabled"));
    const originalIconHtml = selectedBtn.querySelector(".opt-icon").innerHTML;
    selectedBtn.querySelector(".opt-icon").innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    const payload = {
        mesa: mesaNumero,
        tipo: tipo
    };

    // Intentar peticion con reintentos (Resiliencia)
    const exito = await enviarConReintentos("/api/alert", payload, 3, 2000);

    if (exito) {
        closeServiceModal();
        showToast(obtenerMensajeExito(tipo), false);
        activarCooldown();
    } else {
        // Restaurar botones si falla
        optionButtons.forEach(btn => btn.classList.remove("disabled"));
        selectedBtn.querySelector(".opt-icon").innerHTML = originalIconHtml;
        showToast("Error de conexión. Por favor, llama al camarero directamente.", true);
    }
}

/**
 * Realiza un fetch POST al endpoint especificado, reintentando si ocurre un fallo de red.
 */
async function enviarConReintentos(url, data, reintentos = 3, retardo = 2000) {
    for (let i = 0; i < reintentos; i++) {
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(data)
            });

            if (response.ok) {
                return true;
            }
        } catch (error) {
            console.warn(`Intento ${i + 1} fallido. Reintentando en ${retardo}ms...`);
            if (i < reintentos - 1) {
                await new Promise(resolve => setTimeout(resolve, retardo));
            }
        }
    }
    return false;
}

/**
 * Genera el mensaje de exito segun el tipo de accion
 */
function obtenerMensajeExito(tipo) {
    switch (tipo) {
        case 'pedir':
            return "¡Aviso enviado! El camarero vendrá a tomar tu comanda.";
        case 'cuenta':
            return "Cuenta solicitada. Te la traeremos en breve.";
        case 'camarero':
        default:
            return "Camarero avisado. Acudirá a tu mesa pronto.";
    }
}

/**
 * Activa el cooldown para evitar el spam de avisos
 */
function activarCooldown() {
    enCooldown = true;
    const fab = document.getElementById("fab-action");
    
    // Cambiar aspecto del FAB durante el cooldown
    if (fab) {
        fab.style.background = "#272733";
        fab.style.color = "#9fa0aa";
        fab.style.boxShadow = "none";
        fab.style.borderColor = "#3a3a4a";
        fab.querySelector("i").className = "fa-solid fa-hourglass-half";
        fab.querySelector("span").textContent = "Llamada enviada";
    }

    setTimeout(() => {
        enCooldown = false;
        if (fab) {
            fab.style.background = "";
            fab.style.color = "";
            fab.style.boxShadow = "";
            fab.style.borderColor = "";
            fab.querySelector("i").className = "fa-solid fa-bell-ring fa-bounce";
            fab.querySelector("span").textContent = "Llamar / Pedir";
        }
        
        // Reactivar opciones del modal
        const modal = document.getElementById("service-modal");
        const optionButtons = modal.querySelectorAll(".service-option-btn");
        optionButtons.forEach(btn => {
            btn.classList.remove("disabled");
            // Asegurar restaurar iconos
            if (btn.classList.contains("opt-pedir")) {
                btn.querySelector(".opt-icon").innerHTML = '<i class="fa-solid fa-clipboard-list"></i>';
            } else if (btn.classList.contains("opt-waiter")) {
                btn.querySelector(".opt-icon").innerHTML = '<i class="fa-solid fa-bell"></i>';
            } else if (btn.classList.contains("opt-bill")) {
                btn.querySelector(".opt-icon").innerHTML = '<i class="fa-solid fa-credit-card"></i>';
            }
        });
    }, COOLDOWN_TIME);
}

/**
 * Muestra una alerta visual tipo toast
 */
function showToast(message, isError = false) {
    const toast = document.getElementById("toast");
    const toastIcon = document.getElementById("toast-icon");
    const toastMsg = document.getElementById("toast-message");

    if (!toast || !toastIcon || !toastMsg) return;

    toastMsg.textContent = message;

    if (isError) {
        toast.classList.add("error-toast");
        toastIcon.className = "fa-solid fa-circle-exclamation";
    } else {
        toast.classList.remove("error-toast");
        toastIcon.className = "fa-solid fa-circle-check";
    }

    // Mostrar
    toast.classList.add("show");

    // Ocultar tras 4 segundos
    setTimeout(() => {
        toast.classList.remove("show");
    }, 4000);
}
