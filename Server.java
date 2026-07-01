
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.Headers;

import java.io.*;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Servidor HTTP en Java para el sistema de carta digital y avisos.
 * Implementa servidor de archivos estaticos, API REST, Server-Sent Events (SSE)
 * y persistencia local de alertas en pedidos.json.
 */
public class Server {

    private static final int PORT = 3000;
    private static final String DATA_FILE = "pedidos.json";
    private static final List<Alert> activeAlerts = new CopyOnWriteArrayList<>();
    private static final List<HttpExchange> sseClients = new CopyOnWriteArrayList<>();

    public static void main(String[] args) {
        try {
            // Cargar alertas guardadas previamente en pedidos.json
            loadAlertsFromFile();

            // Leer el puerto desde la variable de entorno PORT (Render lo inyecta automaticamente)
            // Si no existe, usar 3000 como valor por defecto para desarrollo local
            String portEnv = System.getenv("PORT");
            int port = (portEnv != null) ? Integer.parseInt(portEnv) : 3000;

            // Crear el servidor HTTP en el puerto especificado
            HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

            // Registrar manejadores (handlers)
            server.createContext("/api/events", new EventsHandler());
            server.createContext("/api/alert", new AlertHandler());
            server.createContext("/api/resolve", new ResolveHandler());
            server.createContext("/mesa", new MesaRedirectHandler());
            server.createContext("/", new StaticFileHandler());

            // Configurar ejecutor multihilo para manejar conexiones concurrentes (esencial para SSE)
            server.setExecutor(Executors.newCachedThreadPool());

            server.start();
            System.out.println("=================================================");
            System.out.println(" SERVIDOR INICIADO CORRECTAMENTE ");
            System.out.println(" Puerto local: " + port);
            System.out.println(" Acceso Administrador (Ordenador): http://localhost:" + port + "/admin.html");
            System.out.println(" Acceso Mesa (Ejemplo): http://localhost:" + port + "/mesa/1");
            System.out.println("=================================================");

            // Hilo de limpieza automatica: elimina alertas con mas de 5 minutos de antiguedad
            iniciarLimpiezaAutomatica();

        } catch (IOException e) {
            System.err.println("Error al iniciar el servidor: " + e.getMessage());
            e.printStackTrace();
        }
    }

    /**
     * Inicia un hilo planificado que comprueba cada 30 segundos si alguna alerta
     * supera los 5 minutos de vida y la elimina, notificando al panel en tiempo real.
     */
    private static void iniciarLimpiezaAutomatica() {
        final long TIEMPO_MAXIMO_MS = 5 * 60 * 1000L; // 5 minutos en milisegundos
        ScheduledExecutorService limpiador = Executors.newSingleThreadScheduledExecutor();
        limpiador.scheduleAtFixedRate(() -> {
            long ahora = System.currentTimeMillis();
            List<Alert> expiradas = activeAlerts.stream()
                    .filter(a -> (ahora - a.timestamp) >= TIEMPO_MAXIMO_MS)
                    .collect(Collectors.toList());

            if (!expiradas.isEmpty()) {
                for (Alert alerta : expiradas) {
                    activeAlerts.remove(alerta);
                    // Notificar al panel administrador que la alerta ha expirado
                    broadcastEvent("resolveAlert", "{\"id\":\"" + alerta.id + "\"}");
                    System.out.println("[Limpieza] Alerta expirada eliminada: Mesa " + alerta.mesa + " (" + alerta.id + ")");
                }
                saveAlertsToFile();
            }
        }, 30, 30, TimeUnit.SECONDS); // primera ejecucion a los 30s, luego cada 30s
        System.out.println("Limpieza automatica activada: alertas se borran tras 5 minutos.");
    }

    /**
     * Representa una alerta enviada por una mesa.
     */
    static class Alert {
        String id;
        String mesa;
        String tipo;
        long timestamp;

        Alert(String id, String mesa, String tipo, long timestamp) {
            this.id = id;
            this.mesa = mesa;
            this.tipo = tipo;
            this.timestamp = timestamp;
        }

        String toJson() {
            return String.format("{\"id\":\"%s\",\"mesa\":\"%s\",\"tipo\":\"%s\",\"timestamp\":%d}",
                    escapeJson(id), escapeJson(mesa), escapeJson(tipo), timestamp);
        }

        private String escapeJson(String input) {
            if (input == null) return "";
            return input.replace("\\", "\\\\")
                        .replace("\"", "\\\"")
                        .replace("\n", "\\n")
                        .replace("\r", "\\r");
        }
    }

    /**
     * Guarda la lista actual de alertas activas en el archivo pedidos.json.
     */
    private static synchronized void saveAlertsToFile() {
        try {
            String json = "[" + activeAlerts.stream()
                    .map(Alert::toJson)
                    .collect(Collectors.joining(",")) + "]";
            Files.writeString(Paths.get(DATA_FILE), json, StandardCharsets.UTF_8);
        } catch (IOException e) {
            System.err.println("Error al guardar alertas en el archivo: " + e.getMessage());
        }
    }

    /**
     * Carga las alertas pendientes desde el archivo pedidos.json si existe.
     */
    private static void loadAlertsFromFile() {
        Path path = Paths.get(DATA_FILE);
        if (!Files.exists(path)) {
            return;
        }
        try {
            String content = Files.readString(path, StandardCharsets.UTF_8).trim();
            if (content.isEmpty() || content.equals("[]")) {
                return;
            }
            // Expresion regular para extraer los campos de cada objeto JSON de alerta
            Pattern pattern = Pattern.compile("\\{\\\"id\\\":\\\"([^\\\"]+)\\\",\\\"mesa\\\":\\\"([^\\\"]+)\\\",\\\"tipo\\\":\\\"([^\\\"]+)\\\",\\\"timestamp\\\":(\\d+)\\}");
            Matcher matcher = pattern.matcher(content);
            while (matcher.find()) {
                String id = matcher.group(1);
                String mesa = matcher.group(2);
                String tipo = matcher.group(3);
                long timestamp = Long.parseLong(matcher.group(4));
                activeAlerts.add(new Alert(id, mesa, tipo, timestamp));
            }
            System.out.println("Alertas cargadas desde el archivo de persistencia: " + activeAlerts.size());
        } catch (Exception e) {
            System.err.println("No se pudo cargar las alertas previas (formato vacio o corrupto): " + e.getMessage());
        }
    }

    /**
     * Envia un evento en tiempo real a todos los clientes del panel de administracion conectados.
     */
    private static void broadcastEvent(String eventType, String data) {
        String message = String.format("event: %s\ndata: %s\n\n", eventType, data);
        byte[] bytes = message.getBytes(StandardCharsets.UTF_8);
        List<HttpExchange> failedClients = new ArrayList<>();

        for (HttpExchange client : sseClients) {
            try {
                OutputStream os = client.getResponseBody();
                os.write(bytes);
                os.flush();
            } catch (IOException e) {
                // Si falla la escritura, es que el cliente se ha desconectado
                failedClients.add(client);
            }
        }

        // Limpiar clientes desconectados
        for (HttpExchange client : failedClients) {
            sseClients.remove(client);
            try {
                client.close();
            } catch (Exception ignored) {}
        }
    }

    /**
     * Handler para Server-Sent Events (SSE). Mantiene la conexion abierta con el panel administrador.
     */
    static class EventsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            String requestMethod = exchange.getRequestMethod();
            if (!requestMethod.equalsIgnoreCase("GET")) {
                exchange.sendResponseHeaders(405, -1); // Method Not Allowed
                return;
            }

            Headers headers = exchange.getResponseHeaders();
            headers.set("Content-Type", "text/event-stream; charset=utf-8");
            headers.set("Cache-Control", "no-cache");
            headers.set("Connection", "keep-alive");
            headers.set("Access-Control-Allow-Origin", "*");

            // Enviar codigo 200 con longitud 0 para indicar transferencia chunked/continua
            exchange.sendResponseHeaders(200, 0);

            // Agregar el cliente a la lista de suscritos
            sseClients.add(exchange);

            // Enviar inmediatamente la lista de alertas pendientes al conectarse
            String initialJson = "[" + activeAlerts.stream()
                    .map(Alert::toJson)
                    .collect(Collectors.joining(",")) + "]";
            
            String initialMessage = String.format("event: initial\ndata: %s\n\n", initialJson);
            try {
                OutputStream os = exchange.getResponseBody();
                os.write(initialMessage.getBytes(StandardCharsets.UTF_8));
                os.flush();
            } catch (IOException e) {
                sseClients.remove(exchange);
                exchange.close();
            }
        }
    }

    /**
     * Handler para registrar una alerta nueva desde una mesa (POST /api/alert).
     */
    static class AlertHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            // Manejar CORS Preflight
            if (exchange.getRequestMethod().equalsIgnoreCase("OPTIONS")) {
                Headers headers = exchange.getResponseHeaders();
                headers.set("Access-Control-Allow-Origin", "*");
                headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
                headers.set("Access-Control-Allow-Headers", "Content-Type");
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            if (!exchange.getRequestMethod().equalsIgnoreCase("POST")) {
                exchange.sendResponseHeaders(405, -1);
                return;
            }

            // Leer cuerpo del POST
            InputStream is = exchange.getRequestBody();
            String body = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))
                    .lines().collect(Collectors.joining("\n"));

            // Extraer mesa y tipo del cuerpo JSON
            String mesa = extractJsonField(body, "mesa");
            String tipo = extractJsonField(body, "tipo");

            if (mesa.isEmpty() || tipo.isEmpty()) {
                sendJsonResponse(exchange, 400, "{\"error\":\"Campos mesa y tipo son requeridos\"}");
                return;
            }

            // Crear y guardar alerta
            String id = UUID.randomUUID().toString();
            long timestamp = System.currentTimeMillis();
            Alert alert = new Alert(id, mesa, tipo, timestamp);
            
            activeAlerts.add(alert);
            saveAlertsToFile();

            // Retransmitir aviso a los paneles conectados
            broadcastEvent("newAlert", alert.toJson());

            sendJsonResponse(exchange, 200, "{\"success\":true,\"id\":\"" + id + "\"}");
        }
    }

    /**
     * Handler para resolver una alerta atendida por el camarero (POST /api/resolve).
     */
    static class ResolveHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (exchange.getRequestMethod().equalsIgnoreCase("OPTIONS")) {
                Headers headers = exchange.getResponseHeaders();
                headers.set("Access-Control-Allow-Origin", "*");
                headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
                headers.set("Access-Control-Allow-Headers", "Content-Type");
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            if (!exchange.getRequestMethod().equalsIgnoreCase("POST")) {
                exchange.sendResponseHeaders(405, -1);
                return;
            }

            InputStream is = exchange.getRequestBody();
            String body = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))
                    .lines().collect(Collectors.joining("\n"));

            String id = extractJsonField(body, "id");

            if (id.isEmpty()) {
                sendJsonResponse(exchange, 400, "{\"error\":\"Campo id es requerido\"}");
                return;
            }

            boolean removed = activeAlerts.removeIf(alert -> alert.id.equals(id));

            if (removed) {
                saveAlertsToFile();
                // Avisar a todos los paneles que la alerta fue atendida
                broadcastEvent("resolveAlert", "{\"id\":\"" + id + "\"}");
                sendJsonResponse(exchange, 200, "{\"success\":true}");
            } else {
                sendJsonResponse(exchange, 404, "{\"error\":\"Alerta no encontrada\"}");
            }
        }
    }

    /**
     * Handler para redireccionar rutas amigables de mesa como `/mesa/3` a `/?mesa=3`
     */
    static class MesaRedirectHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            String path = exchange.getRequestURI().getPath();
            // Formatos esperados: /mesa/1 o /mesa/1/
            String[] parts = path.split("/");
            String mesaId = "";
            if (parts.length > 2) {
                mesaId = parts[2];
            }

            Headers headers = exchange.getResponseHeaders();
            headers.set("Location", "/?mesa=" + mesaId);
            exchange.sendResponseHeaders(302, -1); // 302 Found/Redirect
            exchange.close();
        }
    }

    /**
     * Handler para servir archivos estaticos desde la carpeta './public'
     */
    static class StaticFileHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            String method = exchange.getRequestMethod();
            if (!method.equalsIgnoreCase("GET")) {
                exchange.sendResponseHeaders(405, -1);
                return;
            }

            String uriPath = exchange.getRequestURI().getPath();
            if (uriPath.equals("/")) {
                uriPath = "/index.html";
            }

            // Evitar ataques de Directory Traversal y construir ruta
            Path root = Paths.get("public").toAbsolutePath().normalize();
            Path filePath = root.resolve(uriPath.substring(1)).normalize();

            if (!filePath.startsWith(root)) {
                exchange.sendResponseHeaders(403, -1); // Forbidden
                return;
            }

            if (!Files.exists(filePath) || Files.isDirectory(filePath)) {
                // Servir 404
                sendJsonResponse(exchange, 404, "{\"error\":\"Archivo no encontrado\"}");
                return;
            }

            // Detectar Content-Type correcto
            String contentType = getContentType(filePath.toString());
            byte[] fileBytes = Files.readAllBytes(filePath);

            Headers headers = exchange.getResponseHeaders();
            headers.set("Content-Type", contentType);
            headers.set("Access-Control-Allow-Origin", "*");
            exchange.sendResponseHeaders(200, fileBytes.length);

            OutputStream os = exchange.getResponseBody();
            os.write(fileBytes);
            os.close();
        }

        private String getContentType(String filePath) {
            String pathLower = filePath.toLowerCase();
            if (pathLower.endsWith(".html") || pathLower.endsWith(".htm")) return "text/html; charset=utf-8";
            if (pathLower.endsWith(".css")) return "text/css; charset=utf-8";
            if (pathLower.endsWith(".js")) return "application/javascript; charset=utf-8";
            if (pathLower.endsWith(".png")) return "image/png";
            if (pathLower.endsWith(".jpg") || pathLower.endsWith(".jpeg")) return "image/jpeg";
            if (pathLower.endsWith(".gif")) return "image/gif";
            if (pathLower.endsWith(".svg")) return "image/svg+xml";
            if (pathLower.endsWith(".ico")) return "image/x-icon";
            if (pathLower.endsWith(".mp3")) return "audio/mpeg";
            if (pathLower.endsWith(".wav")) return "audio/wav";
            if (pathLower.endsWith(".json")) return "application/json; charset=utf-8";
            return "application/octet-stream";
        }
    }

    /**
     * Envia una respuesta JSON estandar.
     */
    private static void sendJsonResponse(HttpExchange exchange, int statusCode, String jsonResponse) throws IOException {
        byte[] bytes = jsonResponse.getBytes(StandardCharsets.UTF_8);
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", "application/json; charset=utf-8");
        headers.set("Access-Control-Allow-Origin", "*");
        exchange.sendResponseHeaders(statusCode, bytes.length);
        OutputStream os = exchange.getResponseBody();
        os.write(bytes);
        os.close();
    }

    /**
     * Extrae de forma manual un campo string simple de un JSON plano.
     * Diseñado para evitar el uso de dependencias externas.
     */
    private static String extractJsonField(String json, String fieldName) {
        Pattern pattern = Pattern.compile("\"" + fieldName + "\"\\s*:\\s*\"([^\"]*)\"");
        Matcher matcher = pattern.matcher(json);
        if (matcher.find()) {
            return matcher.group(1);
        }
        return "";
    }
}
