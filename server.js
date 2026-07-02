const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'pedidos.json');

let activeAlerts = [];
const sseClients = new Set();

app.use(express.json());

function saveAlerts() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(activeAlerts, null, 2), 'utf-8');
}

function loadAlerts() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const content = fs.readFileSync(DATA_FILE, 'utf-8').trim();
            if (content && content !== '[]') {
                activeAlerts = JSON.parse(content);
                console.log(`Alertas cargadas desde archivo: ${activeAlerts.length}`);
            }
        }
    } catch (e) {
        console.warn('No se pudieron cargar alertas previas:', e.message);
    }
}

function broadcastEvent(eventType, data) {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(message);
        } catch {
            sseClients.delete(client);
        }
    }
}

app.get('/api/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
    });

    const initialData = JSON.stringify(activeAlerts);
    res.write(`event: initial\ndata: ${initialData}\n\n`);

    sseClients.add(res);

    const heartbeat = setInterval(() => {
        try {
            res.write(': ping\n\n');
        } catch {
            clearInterval(heartbeat);
            sseClients.delete(res);
        }
    }, 25000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
    });
});

app.post('/api/alert', (req, res) => {
    const { mesa, tipo } = req.body;
    if (!mesa || !tipo) {
        return res.status(400).json({ error: 'Campos mesa y tipo son requeridos' });
    }

    const alert = {
        id: crypto.randomUUID(),
        mesa: String(mesa),
        tipo: String(tipo),
        timestamp: Date.now(),
    };

    activeAlerts.push(alert);
    saveAlerts();
    broadcastEvent('newAlert', alert);

    res.json({ success: true, id: alert.id });
});

app.get('/api/alerts', (req, res) => {
    res.json(activeAlerts);
});

app.post('/api/resolve', (req, res) => {
    const { id } = req.body;
    if (!id) {
        return res.status(400).json({ error: 'Campo id es requerido' });
    }

    const idx = activeAlerts.findIndex(a => a.id === id);
    if (idx === -1) {
        return res.status(404).json({ error: 'Alerta no encontrada' });
    }

    activeAlerts.splice(idx, 1);
    saveAlerts();
    broadcastEvent('resolveAlert', { id });

    res.json({ success: true });
});

app.get('/mesa/:id', (req, res) => {
    res.redirect(302, `/?mesa=${req.params.id}`);
});

app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    extensions: ['html', 'htm'],
}));

app.use((req, res) => {
    res.status(404).json({ error: 'Archivo no encontrado' });
});

loadAlerts();

setInterval(() => {
    const ahora = Date.now();
    const maxAge = 5 * 60 * 1000;
    const expiradas = activeAlerts.filter(a => (ahora - a.timestamp) >= maxAge);

    for (const alerta of expiradas) {
        activeAlerts = activeAlerts.filter(a => a.id !== alerta.id);
        broadcastEvent('resolveAlert', { id: alerta.id });
        console.log(`[Limpieza] Alerta expirada eliminada: Mesa ${alerta.mesa} (${alerta.id})`);
    }

    if (expiradas.length > 0) {
        saveAlerts();
    }
}, 30000);

console.log('Limpieza automatica activada: alertas se borran tras 5 minutos.');

app.listen(PORT, () => {
    console.log('=================================================');
    console.log(' SERVIDOR INICIADO CORRECTAMENTE ');
    console.log(` Puerto local: ${PORT}`);
    console.log(` Acceso Administrador: http://localhost:${PORT}/admin.html`);
    console.log(` Acceso Mesa (Ejemplo): http://localhost:${PORT}/mesa/1`);
    console.log('=================================================');
});
