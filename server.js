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
const KDS_READY_FILE = path.join(DATA_DIR, "kds-ready-orders.json");
const CARDAPIO_CLIENT_ID = process.env.CARDAPIO_CLIENT_ID || "";
const CARDAPIO_CLIENT_SECRET = process.env.CARDAPIO_CLIENT_SECRET || "";
const CARDAPIO_TOKEN_URL = process.env.CARDAPIO_TOKEN_URL || "";
const CARDAPIO_ORDERS_URL =
  process.env.CARDAPIO_ORDERS_URL ||
  "https://integracao.cardapioweb.com/api/open_delivery/v1/orders";
const SYNC_OPEN_ORDERS_INTERVAL_MS = Number(process.env.SYNC_OPEN_ORDERS_INTERVAL_MS) || 60000;

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

  if (!fs.existsSync(KDS_READY_FILE)) {
    fs.writeFileSync(KDS_READY_FILE, JSON.stringify([], null, 2));
  }
}

function readOrders() {
  ensureDataFile();
  const orders = readJsonFile(ORDERS_FILE);
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
      neighborhood:
        order.neighborhood === "Bairro nao informado" ||
        order.fulfillmentType === "pickup"
          ? "Retirada"
          : order.neighborhood,
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
  return readJsonFile(EVENTS_FILE);
}

function writeEvents(events) {
  ensureDataFile();
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events.slice(0, 30), null, 2));
}

function readDispatchedOrders() {
  ensureDataFile();
  return readJsonFile(DISPATCHED_FILE);
}

function writeDispatchedOrders(orders) {
  ensureDataFile();
  fs.writeFileSync(DISPATCHED_FILE, JSON.stringify(orders.slice(0, 50), null, 2));
}

function readKdsReadyOrders() {
  ensureDataFile();
  return readJsonFile(KDS_READY_FILE);
}

function writeKdsReadyOrders(orders) {
  ensureDataFile();
  fs.writeFileSync(KDS_READY_FILE, JSON.stringify(orders.slice(0, 300), null, 2));
}

function isSameOrder(left, right) {
  return (
    String(left.number || "") === String(right.number || "") ||
    String(left.orderId || "") === String(right.orderId || "")
  );
}

function markKdsOrderReady(target) {
  const orders = readOrders();
  const order = orders.find((item) => isSameOrder(item, target));

  if (!order) {
    return { ok: false, message: "Pedido nao encontrado no KDS." };
  }

  const readyOrders = readKdsReadyOrders().filter((item) => !isSameOrder(item, order));

  readyOrders.unshift({
    number: order.number,
    orderId: order.orderId,
    customer: order.customer,
    readyAt: Date.now(),
  });

  writeKdsReadyOrders(readyOrders);

  return {
    ok: true,
    action: "ready",
    order: order.number,
  };
}

function kdsItemKey(item, index) {
  return `${index}:${String(item.name || "").toLowerCase()}`;
}

function isPizzaKdsItem(item) {
  const text = normalizeText(`${item.category || ""} ${item.name || ""}`);

  return text.includes("pizza") || text.includes("pizzas");
}

function markKdsItemReady(target) {
  const orders = readOrders();
  const order = orders.find((item) => isSameOrder(item, target));

  if (!order || !Array.isArray(order.items)) {
    return { ok: false, message: "Pedido nao encontrado no KDS." };
  }

  const readyOrders = readKdsReadyOrders();
  const readyIndex = readyOrders.findIndex((item) => isSameOrder(item, order));
  const currentReady = readyIndex >= 0 ? readyOrders[readyIndex] : {
    number: order.number,
    orderId: order.orderId,
    customer: order.customer,
    readyItems: [],
  };
  const readyItems = new Set(currentReady.readyItems || []);

  readyItems.add(String(target.itemKey || ""));

  const pizzaKeys = order.items
    .map((item, index) => ({ item, key: kdsItemKey(item, index) }))
    .filter(({ item }) => isPizzaKdsItem(item))
    .map(({ key }) => key);
  const isOrderReady = pizzaKeys.length > 0 && pizzaKeys.every((key) => readyItems.has(key));
  const nextReady = {
    ...currentReady,
    readyItems: [...readyItems].filter(Boolean),
    readyAt: isOrderReady ? Date.now() : currentReady.readyAt,
  };

  if (readyIndex >= 0) {
    readyOrders[readyIndex] = nextReady;
  } else {
    readyOrders.unshift(nextReady);
  }

  writeKdsReadyOrders(readyOrders);

  return {
    ok: true,
    action: isOrderReady ? "ready" : "item-ready",
    order: order.number,
    itemKey: target.itemKey || "",
  };
}

function recordDispatchedOrder(order, payload) {
  const dispatchedOrders = readDispatchedOrders();
  const dispatchedOrder = {
    number: order.number,
    orderId: order.orderId,
    customer: order.customer || "Cliente",
    neighborhood:
      order.fulfillmentType === "pickup" ||
      order.neighborhood === "Bairro nao informado"
        ? "Retirada"
        : order.neighborhood,
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

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
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

function recordSystemEvent(body, result) {
  const events = readEvents();

  events.unshift({
    receivedAt: new Date().toLocaleString("pt-BR"),
    method: "SYSTEM",
    path: "/sync-open-orders",
    result,
    body,
  });

  writeEvents(events);
  console.log("Sincronizacao:", JSON.stringify({ result, body }, null, 2));
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

function toNumber(value, fallback = 1) {
  const normalized = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

function firstArray(source, paths) {
  for (const currentPath of paths) {
    const value = currentPath.split(".").reduce((current, key) => current?.[key], source);

    if (Array.isArray(value) && value.length > 0) {
      return value;
    }
  }

  return [];
}

function findItemArray(source) {
  const directItems = firstArray(source, [
    "items",
    "orderItems",
    "products",
    "cart.items",
    "bag.items",
    "data.items",
    "data.order.items",
    "pedido.items",
    "pedido.itens",
    "itens",
  ]);

  if (directItems.length > 0) {
    return directItems;
  }

  const queue = [source];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }

    seen.add(current);

    for (const value of Object.values(current)) {
      if (Array.isArray(value) && value.some((item) =>
        item && typeof item === "object" && (
          getDeepValue(item, ["name", "product.name", "item.name", "description", "title"]) ||
          getDeepValue(item, ["quantity", "qty", "amount", "count"])
        )
      )) {
        return value;
      }

      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return [];
}

function normalizeOrderItems(order) {
  return findItemArray(order)
    .map((item) => {
      const name = String(getDeepValue(item, [
        "name",
        "product.name",
        "item.name",
        "description",
        "title",
        "produto.nome",
      ]) || "");

      if (!name) {
        return null;
      }

      return {
        name,
        quantity: toNumber(getDeepValue(item, [
          "quantity",
          "qty",
          "amount",
          "count",
          "quantidade",
        ])),
        category: String(getDeepValue(item, [
          "category.name",
          "category",
          "categoryName",
          "group.name",
          "group",
          "product.category.name",
          "product.category",
          "product.categoryName",
          "produto.categoria.nome",
        ]) || ""),
        notes: extractNoteText(item),
        complements: normalizeComplements(item),
      };
    })
    .filter(Boolean);
}

function textFromNoteValue(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(textFromNoteValue).filter(Boolean).join(" | ");
  }

  if (typeof value === "object") {
    return String(getDeepValue(value, [
      "text",
      "value",
      "name",
      "description",
      "message",
      "note",
      "observation",
      "comment",
    ]) || "");
  }

  return "";
}

function extractNoteText(source) {
  const noteValue = getDeepValue(source, [
    "notes",
    "note",
    "observation",
    "observations",
    "comments",
    "comment",
    "specialInstructions",
    "specialInstruction",
    "additionalInfo",
    "additionalInformation",
    "preparationInstructions",
    "preparationInstruction",
    "customerNotes",
    "customerNote",
    "orderNotes",
    "orderNote",
    "itemNotes",
    "itemNote",
    "comentario",
    "comentarios",
    "observacao",
    "observacoes",
    "instrucoes",
  ]) || findValueByKeyNames(source, [
    "notes",
    "note",
    "observation",
    "observations",
    "comments",
    "comment",
    "specialInstructions",
    "specialInstruction",
    "additionalInfo",
    "additionalInformation",
    "preparationInstructions",
    "preparationInstruction",
    "customerNotes",
    "customerNote",
    "orderNotes",
    "orderNote",
    "itemNotes",
    "itemNote",
    "comentario",
    "comentarios",
    "observacao",
    "observacoes",
    "instrucoes",
  ]);

  return textFromNoteValue(noteValue);
}

function normalizeComplements(item) {
  const complementGroups = firstArray(item, [
    "options",
    "complements",
    "complementos",
    "choices",
    "garnishItems",
    "subItems",
    "modifiers",
  ]);
  const complements = [];

  for (const complement of complementGroups) {
    const nestedItems = firstArray(complement, [
      "items",
      "options",
      "choices",
      "complements",
      "complementos",
      "garnishItems",
    ]);

    if (nestedItems.length > 0) {
      nestedItems.forEach((nestedItem) => {
        const name = String(getDeepValue(nestedItem, [
          "name",
          "description",
          "title",
          "product.name",
          "item.name",
        ]) || "");

        if (name) {
          complements.push({
            name,
            quantity: toNumber(getDeepValue(nestedItem, ["quantity", "qty", "amount", "count"]), 1),
          });
        }
      });
      continue;
    }

    const name = String(getDeepValue(complement, [
      "name",
      "description",
      "title",
      "product.name",
      "item.name",
    ]) || "");

    if (name) {
      complements.push({
        name,
        quantity: toNumber(getDeepValue(complement, ["quantity", "qty", "amount", "count"]), 1),
      });
    }
  }

  return complements;
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

function extractOrdersList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  return (
    payload.orders ||
    payload.items ||
    payload.data?.orders ||
    payload.data?.items ||
    payload.data ||
    payload.content ||
    []
  );
}

function isOpenOrder(order) {
  return !isDispatchEvent(order, normalizeOrder(order));
}

function normalizeSyncedOrders(payload, previousOrders) {
  const previousByOrderId = new Map(previousOrders.map((order) => [String(order.orderId), order]));

  return extractOrdersList(payload)
    .map(normalizeOrder)
    .filter(Boolean)
    .filter(isOpenOrder)
    .map((order) => {
      const previous = previousByOrderId.get(String(order.orderId));

      return {
        ...order,
        arrivedAt: previous?.arrivedAt || order.arrivedAt,
        items: order.items?.length ? order.items : previous?.items || [],
      };
    });
}

async function syncOpenOrders() {
  const token = await getCardapioToken(CARDAPIO_ORDERS_URL);
  const response = await fetch(CARDAPIO_ORDERS_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Falha ao sincronizar pedidos abertos: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const syncedOrders = normalizeSyncedOrders(payload, readOrders());

  writeOrders(syncedOrders);

  return {
    ok: true,
    action: "synced",
    count: syncedOrders.length,
  };
}

async function syncOpenOrdersSafely() {
  try {
    const result = await syncOpenOrders();
    recordSystemEvent({ source: CARDAPIO_ORDERS_URL }, result);
  } catch (error) {
    recordSystemEvent(
      { source: CARDAPIO_ORDERS_URL },
      { ok: false, action: "sync-failed", message: error.message }
    );
  }
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
  const fulfillmentType =
    detectedFulfillmentType ||
    (neighborhood === "Bairro nao informado" ? "pickup" : "delivery");

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
    neighborhood: fulfillmentType === "pickup" ? "Retirada" : neighborhood,
    fulfillmentType,
    arrivedAt: parseDateToTimestamp(
      order.arrivedAt ||
        order.createdAt ||
        order.created_at ||
        order.createdAtTimestamp ||
        order.createdDateTime
    ),
    rawStatus: String(getDeepValue(order, ["status", "orderStatus", "situacao"]) || ""),
    notes: extractNoteText(order),
    items: normalizeOrderItems(order),
  };
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function classifyProductionItem(item) {
  const text = normalizeText(`${item.category} ${item.name}`);
  const isCombo = text.includes("combo");

  if (text.includes("pizza")) {
    return { key: "pizzas", label: "Pizzas", isCombo };
  }

  if (text.includes("esfiha") || text.includes("esfirra")) {
    return { key: "esfihas", label: "Esfihas", isCombo };
  }

  if (text.includes("porcao") || text.includes("porcoes") || text.includes("porção") || text.includes("porções")) {
    return { key: "porcoes", label: "Porções", isCombo };
  }

  if (isCombo) {
    return { key: "combos", label: "Combos", isCombo: true };
  }

  return { key: "outros", label: "Outros", isCombo: false };
}

function buildProductionSummary() {
  const groups = new Map();
  const orders = readOrders();

  for (const order of orders) {
    for (const item of order.items || []) {
      const classification = classifyProductionItem(item);
      const existing = groups.get(classification.key) || {
        key: classification.key,
        label: classification.label,
        units: 0,
        combos: 0,
        commands: new Set(),
        items: new Map(),
      };
      const quantity = toNumber(item.quantity);
      const itemKey = item.name;
      const currentItem = existing.items.get(itemKey) || { name: item.name, quantity: 0 };

      if (classification.isCombo) {
        existing.combos += quantity;
      } else {
        existing.units += quantity;
      }

      existing.commands.add(order.number);
      currentItem.quantity += quantity;
      existing.items.set(itemKey, currentItem);
      groups.set(classification.key, existing);
    }
  }

  return {
    updatedAt: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    orderCount: orders.length,
    groups: ["pizzas", "esfihas", "porcoes", "combos", "outros"]
      .map((key) => groups.get(key))
      .filter(Boolean)
      .map((group) => ({
        key: group.key,
        label: group.label,
        units: group.units,
        combos: group.combos,
        commands: group.commands.size,
        items: [...group.items.values()].sort((a, b) => b.quantity - a.quantity),
      })),
  };
}

function buildKdsOrders() {
  const readyOrders = readKdsReadyOrders();

  return readOrders()
    .filter((order) => Array.isArray(order.items) && order.items.length > 0)
    .filter((order) => !readyOrders.some((readyOrder) => isSameOrder(order, readyOrder) && readyOrder.readyAt))
    .sort((a, b) => a.arrivedAt - b.arrivedAt)
    .map((order) => {
      const readyOrder = readyOrders.find((item) => isSameOrder(item, order));
      const readyItems = new Set(readyOrder?.readyItems || []);

      return {
        number: order.number,
        orderId: order.orderId,
        customer: order.customer,
        fulfillmentType: order.fulfillmentType,
        neighborhood: order.neighborhood,
        arrivedAt: order.arrivedAt,
        notes: order.notes || "",
        items: order.items
          .map((item, index) => ({
            ...item,
            kdsItemKey: kdsItemKey(item, index),
            notes: item.notes || extractNoteText(item),
          }))
          .filter((item) => !readyItems.has(item.kdsItemKey)),
      };
    })
    .filter((order) => order.items.some(isPizzaKdsItem));
}

function buildKdsReadyOrders() {
  const orders = readOrders();
  const readyOrders = readKdsReadyOrders();

  return readyOrders
    .filter((readyOrder) => readyOrder.readyAt)
    .map((readyOrder) => {
      const order = orders.find((item) => isSameOrder(item, readyOrder));

      if (!order || !Array.isArray(order.items) || order.items.length === 0) {
        return null;
      }

      return {
        number: order.number,
        orderId: order.orderId,
        customer: order.customer,
        fulfillmentType: order.fulfillmentType,
        neighborhood: order.neighborhood,
        arrivedAt: order.arrivedAt,
        readyAt: readyOrder.readyAt,
        notes: order.notes || "",
        items: order.items.map((item, index) => ({
          ...item,
          kdsItemKey: kdsItemKey(item, index),
          notes: item.notes || extractNoteText(item),
        })),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.readyAt - a.readyAt);
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
  const routeAliases = {
    "/": "/index.html",
    "/kds": "/kds.html",
    "/producao": "/kds.html",
  };
  const safePath = routeAliases[requestPath] || requestPath;
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
    !["/api/orders", "/api/events", "/api/dispatched-orders", "/api/sync-open-orders", "/api/production-summary", "/api/kds-orders", "/api/kds-ready-orders", "/api/kds-ready", "/api/kds-item-ready"].includes(url.pathname) &&
    !["/", "/index.html", "/app.js", "/kds", "/producao", "/kds.html", "/kds.js", "/styles.css", "/favicon.ico", "/api/webhook/cardapio-web"].includes(
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

  if (request.method === "GET" && url.pathname === "/api/production-summary") {
    sendJson(response, 200, buildProductionSummary());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/kds-orders") {
    sendJson(response, 200, {
      updatedAt: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      orders: buildKdsOrders(),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/kds-ready-orders") {
    sendJson(response, 200, {
      updatedAt: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      orders: buildKdsReadyOrders(),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/kds-ready") {
    try {
      const body = await readBody(request);
      const result = markKdsOrderReady(body);
      sendJson(response, result.ok ? 200 : 404, result);
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Pedido invalido." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/kds-item-ready") {
    try {
      const body = await readBody(request);
      const result = markKdsItemReady(body);
      sendJson(response, result.ok ? 200 : 404, result);
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Produto invalido." });
    }
    return;
  }

  if (["GET", "POST"].includes(request.method) && url.pathname === "/api/sync-open-orders") {
    try {
      const result = await syncOpenOrders();
      recordSystemEvent({ source: CARDAPIO_ORDERS_URL, manual: true }, result);
      sendJson(response, 200, result);
    } catch (error) {
      const result = { ok: false, action: "sync-failed", message: error.message };
      recordSystemEvent({ source: CARDAPIO_ORDERS_URL, manual: true }, result);
      sendJson(response, 500, result);
    }
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
  setTimeout(syncOpenOrdersSafely, 5000);
  setInterval(syncOpenOrdersSafely, SYNC_OPEN_ORDERS_INTERVAL_MS);
});
