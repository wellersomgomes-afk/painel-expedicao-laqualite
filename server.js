const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.RENDER ? "0.0.0.0" : "localhost";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const CARDAPIO_CLIENT_ID = process.env.CARDAPIO_CLIENT_ID || "";
const CARDAPIO_CLIENT_SECRET = process.env.CARDAPIO_CLIENT_SECRET || "";
const CARDAPIO_TOKEN_URL =
  process.env.CARDAPIO_TOKEN_URL || "https://integracao.cardapioweb.com/api/open_delivery/v1/oauth/token";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const initialOrders = [
  { number: "1048", customer: "Mariana", neighborhood: "Centro", arrivedMinutesAgo: 7 },
  { number: "1049", customer: "Rafael", neighborhood: "Jardim Europa", arrivedMinutesAgo: 14 },
  { number: "1050", customer: "Camila", neighborhood: "Vila Nova", arrivedMinutesAgo: 22 },
  { number: "1051", customer: "Fernando", neighborhood: "Santa Luzia", arrivedMinutesAgo: 31 },
  { number: "1052", customer: "Patricia", neighborhood: "Bela Vista", arrivedMinutesAgo: 38 },
  { number: "1053", customer: "Lucas", neighborhood: "Sao Jose", arrivedMinutesAgo: 45 },
].map((order) => ({
  ...order,
  arrivedAt: Date.now() - order.arrivedMinutesAgo * 60 * 1000,
}));

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
  }

  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(initialOrders, null, 2));
  }

  if (!fs.existsSync(EVENTS_FILE)) {
    fs.writeFileSync(EVENTS_FILE, JSON.stringify([], null, 2));
  }
}

function readOrders() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
}

function writeOrders(orders) {
  ensureDataFile();
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function readEvents() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8"));
}

function writeEvents(events) {
  ensureDataFile();
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events.slice(0, 30), null, 2));
}

function recordEvent(request, body, result) {
  const events = readEvents();

  events.unshift({
    receivedAt: new Date().toLocaleString("pt-BR"),
    method: request.method,
    path: request.url,
    result,
    body,
  });

  writeEvents(events);
  console.log("Webhook recebido:", JSON.stringify({ result, body }, null, 2));
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": contentTypes[".json"] });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
    });

    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function getDeepValue(source, paths) {
  for (const currentPath of paths) {
    const value = currentPath.split(".").reduce((current, key) => current?.[key], source);

    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return "";
}

function parseDateToTimestamp(value) {
  if (!value) {
    return Date.now();
  }

  if (typeof value === "number") {
    return value;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

async function getCardapioToken() {
  if (!CARDAPIO_CLIENT_ID || !CARDAPIO_CLIENT_SECRET) {
    throw new Error("Credenciais do Cardapio Web nao configuradas no Render.");
  }

  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const response = await fetch(CARDAPIO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CARDAPIO_CLIENT_ID,
      client_secret: CARDAPIO_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) {
    throw new Error(`Falha ao autenticar no Cardapio Web: HTTP ${response.status}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + Math.max(Number(data.expires_in || 3600) - 60, 60) * 1000;

  if (!cachedToken) {
    throw new Error("Cardapio Web nao retornou access_token.");
  }

  return cachedToken;
}

async function fetchCardapioOrder(orderURL) {
  const token = await getCardapioToken();
  const response = await fetch(orderURL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Falha ao buscar pedido no Cardapio Web: HTTP ${response.status}`);
  }

  return response.json();
}

function normalizeOrder(payload) {
  const order =
    payload.order ||
    payload.pedido ||
    payload.data?.order ||
    payload.data?.pedido ||
    payload.data ||
    payload;
  const number = String(getDeepValue(order, [
    "displayId",
    "displayID",
    "display_id",
    "number",
    "numero",
    "code",
    "codigo",
    "orderId",
    "orderID",
    "id",
  ]));

  if (!number) {
    return null;
  }

  return {
    number,
    customer: String(getDeepValue(order, [
      "customer.name",
      "cliente.nome",
      "customerName",
      "nomeCliente",
      "buyer.name",
      "consumer.name",
    ]) || "Cliente"),
    neighborhood: String(getDeepValue(order, [
      "deliveryAddress.neighborhood",
      "delivery.address.neighborhood",
      "delivery.deliveryAddress.neighborhood",
      "delivery.delivery_address.neighborhood",
      "address.neighborhood",
      "endereco.bairro",
      "customer.address.neighborhood",
      "buyer.address.neighborhood",
      "bairro",
    ]) || "Bairro nao informado"),
    arrivedAt: parseDateToTimestamp(
      order.arrivedAt ||
        order.createdAt ||
        order.created_at ||
        order.createdAtTimestamp ||
        order.createdDateTime
    ),
    rawStatus: String(getDeepValue(order, ["status", "orderStatus", "situacao"]) || ""),
  };
}

function isDispatchEvent(payload, normalizedOrder) {
  const eventText = [
    payload.event,
    payload.type,
    payload.status,
    payload.action,
    normalizedOrder?.rawStatus,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return [
    "dispatch",
    "dispatched",
    "despach",
    "saiu",
    "out_for_delivery",
    "delivered",
    "concluded",
    "cancel",
  ].some((word) => eventText.includes(word));
}

async function handleWebhook(payload) {
  let payloadForOrder = payload;

  if (payload.orderURL) {
    payloadForOrder = await fetchCardapioOrder(payload.orderURL);
  }

  const normalizedOrder = normalizeOrder(payloadForOrder);

  if (!normalizedOrder) {
    return {
      ok: false,
      message: payload.orderURL
        ? "Pedido nao identificado depois de consultar orderURL."
        : "Pedido nao identificado no webhook.",
    };
  }

  const orders = readOrders();
  const currentIndex = orders.findIndex((order) => order.number === normalizedOrder.number);

  if (isDispatchEvent({ ...payload, ...payloadForOrder }, normalizedOrder)) {
    if (currentIndex >= 0) {
      orders.splice(currentIndex, 1);
      writeOrders(orders);
    }

    return { ok: true, action: "removed", order: normalizedOrder.number };
  }

  if (currentIndex >= 0) {
    orders[currentIndex] = { ...orders[currentIndex], ...normalizedOrder };
  } else {
    orders.push(normalizedOrder);
  }

  writeOrders(orders);
  return { ok: true, action: "saved", order: normalizedOrder.number };
}

function serveStatic(request, response) {
  const requestPath = new URL(request.url, `http://${request.headers.host}`).pathname;
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(ROOT, safePath));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "text/plain; charset=utf-8",
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (
    !["/api/orders", "/api/events"].includes(url.pathname) &&
    !["/", "/index.html", "/app.js", "/styles.css", "/favicon.ico", "/api/webhook/cardapio-web"].includes(
      url.pathname
    )
  ) {
    recordEvent(request, { note: "Chamada recebida fora das rotas principais." }, {
      ok: true,
      action: "request-logged",
    });
  }

  if (request.method === "GET" && url.pathname === "/api/orders") {
    const orders = readOrders().sort((a, b) => b.arrivedAt - a.arrivedAt);
    sendJson(response, 200, { orders });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    sendJson(response, 200, { events: readEvents() });
    return;
  }

  if (["GET", "HEAD"].includes(request.method) && url.pathname === "/api/webhook/cardapio-web") {
    const result = { ok: true, message: "Webhook ativo." };
    recordEvent(request, { note: "Teste de acesso ao webhook." }, result);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/webhook/cardapio-web") {
    try {
      const body = await readBody(request);
      const result = await handleWebhook(body);
      recordEvent(request, body, result);
      sendJson(response, result.ok ? 200 : 400, result);
    } catch (error) {
      const result = { ok: false, message: "Webhook invalido." };
      recordEvent(request, { error: error.message }, result);
      sendJson(response, 400, result);
    }
    return;
  }

  serveStatic(request, response);
});

server.listen(PORT, HOST, () => {
  console.log(`Painel rodando em http://localhost:${PORT}`);
  console.log(`Webhook local: http://localhost:${PORT}/api/webhook/cardapio-web`);
});
