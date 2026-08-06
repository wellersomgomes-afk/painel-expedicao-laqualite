const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.RENDER ? "0.0.0.0" : "localhost";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const DISPATCHED_FILE = path.join(DATA_DIR, "dispatched-orders.json");
const CARDAPIO_CLIENT_ID = process.env.CARDAPIO_CLIENT_ID || "";
const CARDAPIO_CLIENT_SECRET = process.env.CARDAPIO_CLIENT_SECRET || "";
const CARDAPIO_TOKEN_URL =
  process.env.CARDAPIO_TOKEN_URL || "";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const initialOrders = [];
const demoOrderNumbers = new Set(["1048", "1049", "1050", "1051", "1052", "1053"]);

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

  if (!fs.existsSync(DISPATCHED_FILE)) {
    fs.writeFileSync(DISPATCHED_FILE, JSON.stringify([], null, 2));
  }
}

function readOrders() {
  ensureDataFile();
  const orders = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
  const realOrders = orders
    .filter((order) =>
      !demoOrderNumbers.has(String(order.number)) &&
      order.orderId &&
      order.orderId !== order.number
    )
    .map((order) => ({
      ...order,
      fulfillmentType:
        order.fulfillmentType ||
        (order.neighborhood === "Bairro nao informado" ? "pickup" : "delivery"),
    }));

  if (realOrders.length !== orders.length) {
    writeOrders(realOrders);
  }

  return realOrders;
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

function readDispatchedOrders() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DISPATCHED_FILE, "utf8"));
}

function writeDispatchedOrders(orders) {
  ensureDataFile();
  fs.writeFileSync(DISPATCHED_FILE, JSON.stringify(orders.slice(0, 50), null, 2));
}

function recordDispatchedOrder(order, payload) {
  const dispatchedOrders = readDispatchedOrders();
  const dispatchedOrder = {
    number: order.number,
    orderId: order.orderId,
    customer: order.customer || "Cliente",
    neighborhood: order.neighborhood || "Bairro nao informado",
    eventType: payload.eventType || "",
    dispatchedAt: Date.now(),
  };
  const withoutDuplicate = dispatchedOrders.filter((item) =>
    item.number !== dispatchedOrder.number &&
    item.orderId !== dispatchedOrder.orderId
  );

  withoutDuplicate.unshift(dispatchedOrder);
  writeDispatchedOrders(withoutDuplicate);
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

function findValueByKeyNames(source, keyNames) {
  if (!source || typeof source !== "object") {
    return "";
  }

  const normalizedKeyNames = keyNames.map((key) => key.toLowerCase());
  const queue = [source];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }

    seen.add(current);

    for (const [key, value] of Object.entries(current)) {
      if (
        normalizedKeyNames.includes(key.toLowerCase()) &&
        value !== undefined &&
        value !== null &&
        value !== ""
      ) {
        return value;
      }

      if (value && typeof value === "object") {
        queue.push(value);
      }
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

function detectFulfillmentType(order) {
  const explicitValue = String(getDeepValue(order, [
    "fulfillmentType",
    "fulfillment",
    "orderType",
    "type",
    "delivery.type",
    "delivery.mode",
    "delivery.deliveryType",
    "takeout.type",
    "pickup.type",
    "serviceType",
  ]) || findValueByKeyNames(order, [
    "fulfillmentType",
    "fulfillment",
    "orderType",
    "deliveryType",
    "serviceType",
    "mode",
  ]) || "").toLowerCase();

  if (
    explicitValue.includes("takeout") ||
    explicitValue.includes("pickup") ||
    explicitValue.includes("retirada") ||
    explicitValue.includes("balcao") ||
    explicitValue.includes("balcão") ||
    explicitValue.includes("withdraw")
  ) {
    return "pickup";
  }

  if (explicitValue.includes("delivery") || explicitValue.includes("entrega")) {
    return "delivery";
  }

  return "";
}

function tokenUrlsFromOrderUrl(orderURL) {
  if (CARDAPIO_TOKEN_URL) {
    return [CARDAPIO_TOKEN_URL];
  }

  const parsedOrderUrl = new URL(orderURL);
  const origin = parsedOrderUrl.origin;
  const orderBaseUrl = orderURL.split("/orders/")[0];
  const baseWithoutVersion = orderBaseUrl.replace(/\/v\d+$/, "");

  return [
    `${origin}/oauth/token`,
    `${origin}/api/oauth/token`,
    `${orderBaseUrl}/oauth/token`,
    `${baseWithoutVersion}/oauth/token`,
    "https://integracao.cardapioweb.com/api/open_delivery/oauth/token",
    "https://integracao.cardapioweb.com/api/open_delivery/v1/oauth/token",
  ];
}

async function getCardapioToken(orderURL) {
  if (!CARDAPIO_CLIENT_ID || !CARDAPIO_CLIENT_SECRET) {
    throw new Error("Credenciais do Cardapio Web nao configuradas no Render.");
  }

  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  let lastError = "";
  let data = null;

  for (const tokenUrl of tokenUrlsFromOrderUrl(orderURL)) {
    const tokenRequests = [
      {
        name: "form",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CARDAPIO_CLIENT_ID,
          client_secret: CARDAPIO_CLIENT_SECRET,
          grant_type: "client_credentials",
        }),
      },
      {
        name: "json",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: CARDAPIO_CLIENT_ID,
          client_secret: CARDAPIO_CLIENT_SECRET,
          grant_type: "client_credentials",
        }),
      },
    ];

    for (const tokenRequest of tokenRequests) {
      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: tokenRequest.headers,
        body: tokenRequest.body,
      });

      if (response.ok) {
        data = await response.json();
        break;
      }

      lastError = `${tokenUrl} (${tokenRequest.name}) retornou HTTP ${response.status}`;
    }

    if (data) {
      break;
    }
  }

  if (!data) {
    throw new Error(`Falha ao autenticar no Cardapio Web: ${lastError}`);
  }

  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + Math.max(Number(data.expires_in || 3600) - 60, 60) * 1000;

  if (!cachedToken) {
    throw new Error("Cardapio Web nao retornou access_token.");
  }

  return cachedToken;
}

async function fetchCardapioOrder(orderURL, payload = {}) {
  const directAttempts = [
    {
      name: "no-auth",
      headers: {
        Accept: "application/json",
      },
    },
    {
      name: "basic",
      headers: {
        Authorization: `Basic ${Buffer.from(`${CARDAPIO_CLIENT_ID}:${CARDAPIO_CLIENT_SECRET}`).toString(
          "base64"
        )}`,
        Accept: "application/json",
      },
    },
    {
      name: "basic-source-app",
      headers: {
        Authorization: `Basic ${Buffer.from(`${CARDAPIO_CLIENT_ID}:${CARDAPIO_CLIENT_SECRET}`).toString(
          "base64"
        )}`,
        "X-Source-App-Id": payload.sourceAppId || "",
        Accept: "application/json",
      },
    },
    {
      name: "secret-bearer",
      headers: {
        Authorization: `Bearer ${CARDAPIO_CLIENT_SECRET}`,
        Accept: "application/json",
      },
    },
    {
      name: "secret-bearer-source-app",
      headers: {
        Authorization: `Bearer ${CARDAPIO_CLIENT_SECRET}`,
        "X-Source-App-Id": payload.sourceAppId || "",
        Accept: "application/json",
      },
    },
    {
      name: "api-key",
      headers: {
        "X-API-Key": CARDAPIO_CLIENT_SECRET,
        "X-Establishment-Id": CARDAPIO_CLIENT_ID,
        Accept: "application/json",
      },
    },
    {
      name: "api-key-source-app",
      headers: {
        "X-API-Key": CARDAPIO_CLIENT_SECRET,
        "X-Establishment-Id": CARDAPIO_CLIENT_ID,
        "X-Source-App-Id": payload.sourceAppId || "",
        Accept: "application/json",
      },
    },
    {
      name: "client-headers",
      headers: {
        "client-id": CARDAPIO_CLIENT_ID,
        "client-secret": CARDAPIO_CLIENT_SECRET,
        Accept: "application/json",
      },
    },
    {
      name: "integration-headers",
      headers: {
        "integration-id": CARDAPIO_CLIENT_ID,
        "integration-secret": CARDAPIO_CLIENT_SECRET,
        "source-app-id": payload.sourceAppId || "",
        Accept: "application/json",
      },
    },
  ];

  const errors = [];

  for (const attempt of directAttempts) {
    const response = await fetch(orderURL, { headers: attempt.headers });

    if (response.ok) {
      return response.json();
    }

    errors.push(`${attempt.name}: HTTP ${response.status}`);
  }

  let token = "";

  try {
    token = await getCardapioToken(orderURL);
  } catch (error) {
    errors.push(`oauth-token: ${error.message}`);
    throw new Error(`Falha ao buscar pedido no Cardapio Web: ${errors.join(" | ")}`);
  }

  const response = await fetch(orderURL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    errors.push(`oauth-bearer: HTTP ${response.status}`);
    throw new Error(`Falha ao buscar pedido no Cardapio Web: ${errors.join(" | ")}`);
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

  const neighborhood = String(getDeepValue(order, [
    "deliveryAddress.neighborhood",
    "delivery.address.neighborhood",
    "delivery.deliveryAddress.neighborhood",
    "delivery.delivery_address.neighborhood",
    "deliveryAddress.district",
    "delivery.address.district",
    "delivery.deliveryAddress.district",
    "deliveryAddress.neighbourhood",
    "delivery.address.neighbourhood",
    "delivery.deliveryAddress.neighbourhood",
    "address.neighborhood",
    "address.district",
    "address.neighbourhood",
    "endereco.bairro",
    "customer.address.neighborhood",
    "customer.address.district",
    "buyer.address.neighborhood",
    "buyer.address.district",
    "bairro",
    "district",
    "neighborhood",
    "neighbourhood",
  ]) || findValueByKeyNames(order, [
    "bairro",
    "neighborhood",
    "neighbourhood",
    "district",
    "districtName",
    "area",
    "zone",
  ]) || "Bairro nao informado");
  const detectedFulfillmentType = detectFulfillmentType(order);

  return {
    number,
    orderId: String(getDeepValue(order, [
      "orderId",
      "orderID",
      "id",
    ]) || number),
    customer: String(getDeepValue(order, [
      "customer.name",
      "cliente.nome",
      "customerName",
      "nomeCliente",
      "buyer.name",
      "consumer.name",
    ]) || "Cliente"),
    neighborhood,
    fulfillmentType:
      detectedFulfillmentType ||
      (neighborhood === "Bairro nao informado" ? "pickup" : "delivery"),
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
  const eventType = String(payload.eventType || "").toUpperCase();
  const activeEventTypes = new Set(["CREATED", "CONFIRMED", "ACCEPTED", "PREPARING", "READY"]);
  const removeEventTypes = new Set([
    "DISPATCHED",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "CONCLUDED",
    "FINISHED",
    "COMPLETED",
    "CANCELED",
    "CANCELLED",
  ]);

  if (activeEventTypes.has(eventType)) {
    return false;
  }

  if (removeEventTypes.has(eventType)) {
    return true;
  }

  const eventText = [
    payload.eventType,
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
    "out for delivery",
    "ready_for_pickup",
    "ready for pickup",
    "pickedup",
    "picked_up",
    "picked up",
    "sent",
    "shipped",
    "delivered",
    "delivery",
    "concluded",
    "finished",
    "completed",
    "cancel",
  ].some((word) => eventText.includes(word));
}

async function handleWebhook(payload) {
  let payloadForOrder = payload;
  const shouldRemoveFromWebhook = isDispatchEvent(payload, null);

  if (payload.orderURL && !shouldRemoveFromWebhook) {
    payloadForOrder = await fetchCardapioOrder(payload.orderURL, payload);
  }

  const normalizedOrder = normalizeOrder(payloadForOrder) || {
    number: String(payload.orderId || payload.orderID || payload.id || ""),
    orderId: String(payload.orderId || payload.orderID || payload.id || ""),
    customer: "",
    neighborhood: "",
    fulfillmentType: "delivery",
    arrivedAt: Date.now(),
    rawStatus: "",
  };

  if (!normalizedOrder.number) {
    return {
      ok: false,
      message: payload.orderURL
        ? "Pedido nao identificado depois de consultar orderURL."
        : "Pedido nao identificado no webhook.",
    };
  }

  const orders = readOrders();
  const currentIndex = orders.findIndex((order) =>
    order.number === normalizedOrder.number ||
    order.orderId === normalizedOrder.orderId ||
    order.orderId === String(payload.orderId || "") ||
    order.number === String(payload.orderId || "")
  );

  if (shouldRemoveFromWebhook || isDispatchEvent({ ...payload, ...payloadForOrder }, normalizedOrder)) {
    if (currentIndex >= 0) {
      const removedOrder = orders.splice(currentIndex, 1)[0];
      writeOrders(orders);
      recordDispatchedOrder(removedOrder, payload);
    }

    return {
      ok: true,
      action: "removed",
      order: normalizedOrder.number,
      eventType: payload.eventType || "",
    };
  }

  if (currentIndex >= 0) {
    orders[currentIndex] = { ...orders[currentIndex], ...normalizedOrder };
  } else {
    orders.push(normalizedOrder);
  }

  writeOrders(orders);
  return {
    ok: true,
    action: "saved",
    order: normalizedOrder.number,
    customer: normalizedOrder.customer,
    neighborhood: normalizedOrder.neighborhood,
    fulfillmentType: normalizedOrder.fulfillmentType,
  };
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

  if (request.method === "GET" && url.pathname === "/api/dispatched-orders") {
    sendJson(response, 200, { orders: readDispatchedOrders() });
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
