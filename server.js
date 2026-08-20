const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.RENDER ? "0.0.0.0" : "localhost";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const DISPATCHED_FILE = path.join(DATA_DIR, "dispatched-orders.json");
const KDS_READY_FILE = path.join(DATA_DIR, "kds-ready-orders.json");
const PDV_PRODUCT_SECTORS_FILE = path.join(DATA_DIR, "pdv-product-sectors.json");
const CATEGORY_SECTORS_FILE = path.join(DATA_DIR, "category-sectors.json");
const DRIVERS_FILE = path.join(DATA_DIR, "drivers.json");
const CARDAPIO_CLIENT_ID = process.env.CARDAPIO_CLIENT_ID || "";
const CARDAPIO_CLIENT_SECRET = process.env.CARDAPIO_CLIENT_SECRET || "";
const CARDAPIO_API_KEY = process.env.CARDAPIO_API_KEY || "";
const CARDAPIO_PARTNER_KEY = process.env.CARDAPIO_PARTNER_KEY || "";
const CARDAPIO_TOKEN_URL = process.env.CARDAPIO_TOKEN_URL || "";
const CARDAPIO_READY_ENDPOINT_TEMPLATE =
  process.env.CARDAPIO_READY_ENDPOINT_TEMPLATE || "{orderURL}/readyForPickup";
const CARDAPIO_ORDERS_URL =
  process.env.CARDAPIO_ORDERS_URL ||
  "https://integracao.cardapioweb.com/api/open_delivery/v1/orders";
const CARDAPIO_PARTNER_ORDERS_URL =
  process.env.CARDAPIO_PARTNER_ORDERS_URL ||
  "https://integracao.cardapioweb.com/api/partner/v1/orders";
const CARDAPIO_EVENTS_URL =
  process.env.CARDAPIO_EVENTS_URL ||
  "https://integracao.cardapioweb.com/api/open_delivery/v1/events:polling";
const CARDAPIO_EVENTS_ACK_URL = process.env.CARDAPIO_EVENTS_ACK_URL || "";
const SYNC_OPEN_ORDERS_INTERVAL_MS = Number(process.env.SYNC_OPEN_ORDERS_INTERVAL_MS) || 10000;
const APP_TIME_ZONE = "America/Sao_Paulo";
const HIDE_TEST_ORDERS =
  Boolean(process.env.RENDER) || process.env.HIDE_TEST_ORDERS === "true";
const MAX_EVENTS_STORED = Number(process.env.MAX_EVENTS_STORED) || 12;
const MAX_DISPATCHED_STORED = Number(process.env.MAX_DISPATCHED_STORED) || 80;
const MAX_READY_STORED = Number(process.env.MAX_READY_STORED) || 120;
const MAX_UPDATE_CLIENTS = Number(process.env.MAX_UPDATE_CLIENTS) || 20;
const UPDATE_CLIENT_TTL_MS = Number(process.env.UPDATE_CLIENT_TTL_MS) || 10 * 60 * 1000;
const MAX_REQUEST_BODY_BYTES = Number(process.env.MAX_REQUEST_BODY_BYTES) || 1024 * 1024;
const MAX_EVENT_LOG_TEXT = Number(process.env.MAX_EVENT_LOG_TEXT) || 700;
const MAX_EVENT_LOG_KEYS = Number(process.env.MAX_EVENT_LOG_KEYS) || 24;
const MEMORY_GC_THRESHOLD_MB = Number(process.env.MEMORY_GC_THRESHOLD_MB) || 360;
const MEMORY_FORCE_COMPACT_THRESHOLD_MB = Number(process.env.MEMORY_FORCE_COMPACT_THRESHOLD_MB) || 430;
const ENABLE_KDS = process.env.ENABLE_KDS !== "false";
// Reativacao futura: incluir "esfihas" e "porcoes" aqui para voltar esses setores ao nosso KDS de producao.
const ACTIVE_PRODUCTION_KDS_SECTORS = new Set(["pizzas"]);
const DISPATCHABLE_KDS_SECTORS = new Set(["pizzas", "esfihas", "porcoes"]);
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "qualidade123";
const PANEL_SESSION_SECRET =
  process.env.PANEL_SESSION_SECRET || CARDAPIO_CLIENT_SECRET || PANEL_PASSWORD;
const PANEL_AUTH_COOKIE = "laqualite_auth";
const PANEL_AUTH_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

let cachedToken = null;
let cachedTokenExpiresAt = 0;
let partnerOrdersLastSuccessfulSyncAt = 0;
let partnerOrdersSyncInFlight = null;
let openOrdersSyncInFlight = null;
const orderLocks = new Map();
const storageCache = new Map();
const storageWriteQueues = new Map();
const eventClients = new Map();
let storageMode = "json";
let storageDb = null;
let storageReady = false;
let storageError = "";
let dataVersion = 0;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

const initialOrders = [];
const demoOrderNumbers = new Set(["1048", "1049", "1050", "1051", "1052", "1053"]);

function localDateKey(value = Date.now()) {
  const timestamp = Number(value);

  if (!Number.isFinite(timestamp)) {
    return "";
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function isTodayTimestamp(value) {
  const todayKey = localDateKey();
  const valueKey = localDateKey(value);

  return Boolean(todayKey && valueKey && todayKey === valueKey);
}

function isActiveWorkdayOrder(order) {
  return (
    isTodayTimestamp(order?.arrivedAt) ||
    isTodayTimestamp(order?.readyAt) ||
    isTodayTimestamp(order?.lastSeenOpenAt) ||
    isTodayTimestamp(order?.dispatchedAt)
  );
}

function isTestOrderRecord(order) {
  return (
    String(order?.orderId || "").startsWith("teste-") ||
    String(order?.orderURL || "").includes("/api/test-orders/")
  );
}

function shouldShowWorkdayOrder(order) {
  return isActiveWorkdayOrder(order) && (!HIDE_TEST_ORDERS || !isTestOrderRecord(order) || order?.loadTest === true);
}

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

  if (!fs.existsSync(PDV_PRODUCT_SECTORS_FILE)) {
    fs.writeFileSync(PDV_PRODUCT_SECTORS_FILE, JSON.stringify({ esfihas: [], porcoes: [] }, null, 2));
  }

  if (!fs.existsSync(CATEGORY_SECTORS_FILE)) {
    fs.writeFileSync(CATEGORY_SECTORS_FILE, JSON.stringify({ esfihas: [], porcoes: [] }, null, 2));
  }

  if (!fs.existsSync(DRIVERS_FILE)) {
    fs.writeFileSync(DRIVERS_FILE, JSON.stringify([], null, 2));
  }
}

function defaultJsonValue(filePath) {
  if (filePath === PDV_PRODUCT_SECTORS_FILE || filePath === CATEGORY_SECTORS_FILE) {
    return { esfihas: [], porcoes: [] };
  }

  return [];
}

function writeJsonFile(filePath, data) {
  ensureDataFile();
  const key = storageKeyFromFile(filePath);
  const compactData = key ? compactStorageData(key, data) : data;

  if (storageMode === "postgres" && storageReady && key) {
    storageCache.set(key, cloneJson(compactData));
    queueStorageWrite(key, compactData);
    return;
  }

  writeJsonFileDirect(filePath, compactData);
}

function writeJsonFileDirect(filePath, data) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function storageKeyFromFile(filePath) {
  return path.basename(filePath, ".json");
}

function compactStorageData(key, data) {
  if (!Array.isArray(data)) {
    return data;
  }

  if (key === storageKeyFromFile(EVENTS_FILE)) {
    return data.slice(0, MAX_EVENTS_STORED);
  }

  if (key === storageKeyFromFile(ORDERS_FILE)) {
    return data
      .filter((order) =>
        !demoOrderNumbers.has(String(order.number)) &&
        order.orderId &&
        order.orderId !== order.number &&
        shouldShowWorkdayOrder(order)
      )
      .slice(0, 300);
  }

  if (key === storageKeyFromFile(KDS_READY_FILE)) {
    if (!ENABLE_KDS) {
      return [];
    }

    return data.filter(shouldShowWorkdayOrder).slice(0, MAX_READY_STORED);
  }

  if (key === storageKeyFromFile(DISPATCHED_FILE)) {
    return data.filter(shouldShowWorkdayOrder).slice(0, MAX_DISPATCHED_STORED);
  }

  return data;
}

function storageFileEntries() {
  return [
    [storageKeyFromFile(ORDERS_FILE), ORDERS_FILE],
    [storageKeyFromFile(EVENTS_FILE), EVENTS_FILE],
    [storageKeyFromFile(DISPATCHED_FILE), DISPATCHED_FILE],
    [storageKeyFromFile(KDS_READY_FILE), KDS_READY_FILE],
    [storageKeyFromFile(PDV_PRODUCT_SECTORS_FILE), PDV_PRODUCT_SECTORS_FILE],
    [storageKeyFromFile(CATEGORY_SECTORS_FILE), CATEGORY_SECTORS_FILE],
    [storageKeyFromFile(DRIVERS_FILE), DRIVERS_FILE],
  ];
}

async function initializeStorage() {
  ensureDataFile();

  if (!process.env.DATABASE_URL) {
    storageMode = "json";
    storageReady = true;
    return;
  }

  try {
    const { Pool } = require("pg");
    storageDb = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.RENDER ? { rejectUnauthorized: false } : undefined,
    });

    await storageDb.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        key text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const [key, filePath] of storageFileEntries()) {
      const dbResult = await storageDb.query("SELECT data FROM app_state WHERE key = $1", [key]);

      if (dbResult.rows.length) {
        const compactData = compactStorageData(key, dbResult.rows[0].data);
        storageCache.set(key, compactData);

        if (JSON.stringify(compactData) !== JSON.stringify(dbResult.rows[0].data)) {
          await persistStorageValue(key, compactData);
        }

        continue;
      }

      const fileData = compactStorageData(key, readJsonFileDirect(filePath));
      storageCache.set(key, fileData);
      await persistStorageValue(key, fileData);
    }

    storageMode = "postgres";
    storageReady = true;
  } catch (error) {
    storageMode = "json";
    storageReady = true;
    storageError = error.message;
    console.warn("PostgreSQL indisponivel, usando arquivos JSON:", error.message);
  }
}

async function persistStorageValue(key, data) {
  if (!storageDb) {
    return;
  }

  await storageDb.query(
    `
      INSERT INTO app_state (key, data, updated_at)
      VALUES ($1, $2::jsonb, now())
      ON CONFLICT (key)
      DO UPDATE SET data = EXCLUDED.data, updated_at = now()
    `,
    [key, JSON.stringify(data)]
  );
}

function queueStorageWrite(key, data) {
  if (!storageDb) {
    return;
  }

  const previous = storageWriteQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => persistStorageValue(key, data))
    .catch((error) => {
      storageError = error.message;
      console.error("Falha ao salvar no PostgreSQL:", error.message);
    })
    .finally(() => {
      if (storageWriteQueues.get(key) === next) {
        storageWriteQueues.delete(key);
      }
    });

  storageWriteQueues.set(key, next);
}

function compactOperationalState() {
  const entries = [
    [ORDERS_FILE, "orders"],
    [EVENTS_FILE, "events"],
    [DISPATCHED_FILE, "dispatched-orders"],
    [KDS_READY_FILE, "kds-ready-orders"],
  ];

  for (const [filePath, notifyType] of entries) {
    const key = storageKeyFromFile(filePath);
    const currentData = readJsonFile(filePath);
    const compactData = compactStorageData(key, currentData);

    if (JSON.stringify(currentData) !== JSON.stringify(compactData)) {
      writeJsonFile(filePath, compactData);
      notifyDataChanged(notifyType);
    }
  }

  pruneEventClients();
  collectGarbageIfAvailable();
}

function collectGarbageIfAvailable() {
  if (typeof global.gc === "function") {
    global.gc();
  }
}

function maintainMemoryPressure() {
  const memory = memorySnapshot();

  if (memory.rssMb < MEMORY_GC_THRESHOLD_MB) {
    pruneEventClients();
    return memory;
  }

  compactOperationalState();

  const nextMemory = memorySnapshot();

  if (nextMemory.rssMb >= MEMORY_FORCE_COMPACT_THRESHOLD_MB) {
    collectGarbageIfAvailable();
    return memorySnapshot();
  }

  return nextMemory;
}

function notifyDataChanged(type = "data") {
  dataVersion += 1;
  const payload = JSON.stringify({
    type,
    version: dataVersion,
    updatedAt: formatLocalDateTime(),
  });

  for (const [client] of eventClients) {
    try {
      client.write(`event: update\ndata: ${payload}\n\n`);
    } catch (error) {
      eventClients.delete(client);
    }
  }
}

function openEventStream(request, response) {
  pruneEventClients();

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  response.write(`event: ready\ndata: ${JSON.stringify({ version: dataVersion })}\n\n`);
  eventClients.set(response, Date.now());

  request.on("close", () => {
    eventClients.delete(response);
  });
}

function pruneEventClients() {
  const now = Date.now();

  for (const [client, connectedAt] of eventClients) {
    if (now - connectedAt > UPDATE_CLIENT_TTL_MS || client.destroyed || client.writableEnded) {
      eventClients.delete(client);

      try {
        client.end();
      } catch (error) {}
    }
  }

  while (eventClients.size > MAX_UPDATE_CLIENTS) {
    const oldestClient = eventClients.keys().next().value;

    if (!oldestClient) {
      break;
    }

    eventClients.delete(oldestClient);

    try {
      oldestClient.end();
    } catch (error) {}
  }
}

function pingEventClients() {
  pruneEventClients();

  for (const [client] of eventClients) {
    try {
      client.write(`event: ping\ndata: ${JSON.stringify({ version: dataVersion })}\n\n`);
    } catch (error) {
      eventClients.delete(client);
    }
  }
}

function orderLockKey(target) {
  return String(target?.orderId || target?.number || "");
}

async function withOrderLock(target, task) {
  const key = orderLockKey(target);

  if (!key) {
    return task();
  }

  const previous = orderLocks.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (orderLocks.get(key) === next) {
        orderLocks.delete(key);
      }
    });

  orderLocks.set(key, next);
  return next;
}

function readOrders() {
  ensureDataFile();
  const orders = readJsonFile(ORDERS_FILE);
  const realOrders = orders
    .filter((order) =>
      !demoOrderNumbers.has(String(order.number)) &&
      order.orderId &&
      order.orderId !== order.number &&
      shouldShowWorkdayOrder(order)
    )
    .map((order) => ({
      ...order,
      fulfillmentType:
        order.fulfillmentType ||
        (order.neighborhood === "Bairro nao informado" ? "pickup" : "delivery"),
      neighborhood:
        order.neighborhood === "Bairro nao informado" ||
        order.fulfillmentType === "pickup"
          ? ""
          : order.neighborhood,
      city: order.fulfillmentType === "pickup" ? "" : order.city,
    }));

  if (realOrders.length !== orders.length) {
    writeOrders(realOrders);
  }

  return realOrders;
}

function writeOrders(orders) {
  writeJsonFile(ORDERS_FILE, orders);
  notifyDataChanged("orders");
}

function readEvents() {
  ensureDataFile();
  return readJsonFile(EVENTS_FILE);
}

function writeEvents(events) {
  writeJsonFile(EVENTS_FILE, events.slice(0, MAX_EVENTS_STORED));
  notifyDataChanged("events");
}

function readDispatchedOrders() {
  ensureDataFile();
  return readJsonFile(DISPATCHED_FILE).filter(shouldShowWorkdayOrder);
}

function readDrivers() {
  ensureDataFile();
  return readJsonFile(DRIVERS_FILE);
}

function writeDrivers(drivers) {
  writeJsonFile(DRIVERS_FILE, drivers);
  notifyDataChanged("drivers");
}

function normalizeDriverName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function saveDriver(payload) {
  const name = normalizeDriverName(payload.name);

  if (!name) {
    return { ok: false, message: "Informe o nome do motoboy." };
  }

  const drivers = readDrivers();
  const duplicate = drivers.some((driver) => normalizeText(driver.name) === normalizeText(name));

  if (duplicate) {
    return { ok: false, message: "Motoboy ja cadastrado." };
  }

  const driver = {
    id: String(Date.now()),
    name,
    createdAt: Date.now(),
  };

  drivers.push(driver);
  writeDrivers(drivers.sort((left, right) => left.name.localeCompare(right.name, "pt-BR")));

  return { ok: true, driver };
}

function removeDriver(payload) {
  const driverId = String(payload.id || "");
  const drivers = readDrivers();
  const nextDrivers = drivers.filter((driver) => String(driver.id) !== driverId);

  if (nextDrivers.length === drivers.length) {
    return { ok: false, message: "Motoboy nao encontrado." };
  }

  writeDrivers(nextDrivers);
  return { ok: true };
}

function driverFromPayload(payload) {
  const driverId = String(payload.driverId || "");
  const driverName = normalizeDriverName(payload.driverName);
  const driver = readDrivers().find((item) => String(item.id) === driverId);

  if (driver) {
    return { id: driver.id, name: driver.name };
  }

  if (driverName) {
    return { id: driverId, name: driverName };
  }

  return null;
}

function normalizePdvCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeExternalId(value) {
  return String(value || "").trim();
}

function readPdvProductSectors() {
  ensureDataFile();

  try {
    const configured = readJsonFile(PDV_PRODUCT_SECTORS_FILE);

    return {
      esfihas: new Set((configured.esfihas || []).map(normalizePdvCode).filter(Boolean)),
      porcoes: new Set((configured.porcoes || []).map(normalizePdvCode).filter(Boolean)),
    };
  } catch (error) {
    return {
      esfihas: new Set(),
      porcoes: new Set(),
    };
  }
}

function readCategorySectors() {
  ensureDataFile();

  try {
    const configured = readJsonFile(CATEGORY_SECTORS_FILE);

    return {
      esfihas: new Set((configured.esfihas || []).map(normalizeExternalId).filter(Boolean)),
      porcoes: new Set((configured.porcoes || []).map(normalizeExternalId).filter(Boolean)),
    };
  } catch (error) {
    return {
      esfihas: new Set(),
      porcoes: new Set(),
    };
  }
}

function sectorsFromPdvCodes(codes) {
  const pdvMap = readPdvProductSectors();
  const sectors = new Set();

  for (const code of codes || []) {
    const normalizedCode = normalizePdvCode(code);

    if (pdvMap.esfihas.has(normalizedCode)) {
      sectors.add("esfihas");
    }

    if (pdvMap.porcoes.has(normalizedCode)) {
      sectors.add("porcoes");
    }
  }

  return [...sectors];
}

function sectorsFromCategoryIds(categoryIds) {
  const categoryMap = readCategorySectors();
  const sectors = new Set();

  for (const categoryId of categoryIds || []) {
    const normalizedCategoryId = normalizeExternalId(categoryId);

    if (categoryMap.esfihas.has(normalizedCategoryId)) {
      sectors.add("esfihas");
    }

    if (categoryMap.porcoes.has(normalizedCategoryId)) {
      sectors.add("porcoes");
    }
  }

  return [...sectors];
}

function writeDispatchedOrders(orders) {
  writeJsonFile(DISPATCHED_FILE, orders.slice(0, MAX_DISPATCHED_STORED));
  notifyDataChanged("dispatched-orders");
}

function clearDispatchedOrders() {
  const count = readJsonFile(DISPATCHED_FILE).length;
  writeDispatchedOrders([]);

  return {
    ok: true,
    action: "dispatched-cleared",
    count,
  };
}

function readKdsReadyOrders() {
  ensureDataFile();
  return readJsonFile(KDS_READY_FILE).filter(shouldShowWorkdayOrder);
}

function writeKdsReadyOrders(orders) {
  writeJsonFile(KDS_READY_FILE, orders.slice(0, MAX_READY_STORED));
  notifyDataChanged("kds-ready-orders");
}

function isSameOrder(left, right) {
  return (
    String(left.number || "") === String(right.number || "") ||
    String(left.orderId || "") === String(right.orderId || "")
  );
}

function isOrderAlreadyDispatched(order) {
  return readDispatchedOrders().some((dispatchedOrder) => isSameOrder(dispatchedOrder, order));
}

function cardapioOrderUrl(order) {
  if (order.orderURL) {
    return order.orderURL;
  }

  return `${CARDAPIO_ORDERS_URL.replace(/\/$/, "")}/${encodeURIComponent(order.orderId || order.number)}`;
}

async function notifyCardapioOrderReady(order) {
  if (String(order.orderId || "").startsWith("teste-")) {
    return {
      ok: true,
      action: "local-test-order-ready",
      order: order.number,
      message: "Pedido teste marcado pronto apenas no localhost.",
    };
  }

  const orderURL = cardapioOrderUrl(order);
  const readyURL = CARDAPIO_READY_ENDPOINT_TEMPLATE
    .replace("{orderId}", encodeURIComponent(order.orderId || order.number))
    .replace("{orderURL}", orderURL.replace(/\/$/, ""));
  const token = await getCardapioToken(orderURL);
  const response = await fetch(readyURL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${readyURL} retornou HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }

  return {
    ok: true,
    action: "cardapio-order-ready",
    order: order.number,
  };
}

async function notifyCardapioOrderReadySafely(order) {
  try {
    return await notifyCardapioOrderReady(order);
  } catch (error) {
    return {
      ok: false,
      action: "cardapio-order-ready-failed",
      order: order.number,
      message: error.message,
    };
  }
}

function kdsItemKey(item, index) {
  return `${index}:${String(item.name || "").toLowerCase()}`;
}

function kdsItemFingerprint(item) {
  const complements = (item.complements || [])
    .map((complement) => ({
      name: normalizeText(complement.name || ""),
      quantity: Number(complement.quantity || 0),
      notes: normalizeText(complement.notes || ""),
      pdvCodes: [...(complement.pdvCodes || [])].map(normalizePdvCode).sort(),
      categoryIds: [...(complement.categoryIds || [])].map(String).sort(),
    }))
    .sort((a, b) => `${a.name}:${a.quantity}`.localeCompare(`${b.name}:${b.quantity}`));

  return JSON.stringify({
    name: normalizeText(item.name || ""),
    quantity: Number(item.quantity || 0),
    notes: normalizeText(item.notes || ""),
    pdvCodes: [...(item.pdvCodes || [])].map(normalizePdvCode).sort(),
    categoryIds: [...(item.categoryIds || [])].map(String).sort(),
    complements,
  });
}

function isProductionKdsItem(item) {
  const classification = classifyProductionItem(item);

  return ACTIVE_PRODUCTION_KDS_SECTORS.has(classification.key);
}

function isDispatchableKdsItem(item) {
  const classification = classifyProductionItem(item);

  return DISPATCHABLE_KDS_SECTORS.has(classification.key);
}

function productionItemKeys(order) {
  return (order.items || [])
    .map((item, index) => ({ item, key: kdsItemKey(item, index) }))
    .filter(({ item }) => isProductionKdsItem(item))
    .map(({ key }) => key);
}

function dispatchableItemKeys(order) {
  return (order.items || [])
    .map((item, index) => ({ item, key: kdsItemKey(item, index) }))
    .filter(({ item }) => isDispatchableKdsItem(item))
    .map(({ key }) => key);
}

function isKdsOrderComplete(order, readyOrder) {
  const productionKeys = productionItemKeys(order);
  const readyItems = new Set(readyOrder?.readyItems || []);

  return productionKeys.length > 0 && productionKeys.every((key) => readyItems.has(key));
}

function changedProductionItemKeys(previousOrder, nextOrder) {
  if (!previousOrder || !Array.isArray(previousOrder.items) || !Array.isArray(nextOrder.items)) {
    return [];
  }

  const previousItems = new Map(
    previousOrder.items
      .map((item, index) => ({ item, key: kdsItemKey(item, index) }))
      .filter(({ item }) => isProductionKdsItem(item))
      .map(({ item, key }) => [key, kdsItemFingerprint(item)])
  );

  return nextOrder.items
    .map((item, index) => ({ item, key: kdsItemKey(item, index) }))
    .filter(({ item }) => isProductionKdsItem(item))
    .filter(({ item, key }) => previousItems.has(key) && previousItems.get(key) !== kdsItemFingerprint(item))
    .map(({ key }) => key);
}

function reconcileKdsReadyOrder(order, previousOrder = null) {
  const readyOrders = readKdsReadyOrders();
  const readyIndex = readyOrders.findIndex((item) => isSameOrder(item, order));

  if (readyIndex < 0) {
    return;
  }

  const readyOrder = readyOrders[readyIndex];
  const productionKeys = new Set(productionItemKeys(order));
  const changedItems = new Set(changedProductionItemKeys(previousOrder, order));
  const readyItems = (readyOrder.readyItems || [])
    .filter((key) => productionKeys.has(key))
    .filter((key) => !changedItems.has(key));
  const isComplete = productionKeys.size > 0 && [...productionKeys].every((key) => readyItems.includes(key));
  const nextReady = {
    ...readyOrder,
    number: order.number,
    orderId: order.orderId,
    customer: order.customer,
    readyItems,
    readyAt: isComplete ? readyOrder.readyAt : null,
  };

  if (readyItems.length === 0 && !nextReady.readyAt) {
    readyOrders.splice(readyIndex, 1);
  } else {
    readyOrders[readyIndex] = nextReady;
  }

  writeKdsReadyOrders(readyOrders);
}

function isPizzaKdsItem(item) {
  const text = normalizeText(`${item.category || ""} ${item.name || ""}`);

  return text.includes("pizza") || text.includes("pizzas");
}

async function saveKdsReadyItems(target, source) {
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
  const targetKeys = Array.isArray(target.itemKeys) && target.itemKeys.length > 0
    ? target.itemKeys
    : [target.itemKey].filter(Boolean);

  targetKeys.forEach((key) => readyItems.add(String(key || "")));

  const allKdsKeys = productionItemKeys(order);
  const isOrderReady =
    allKdsKeys.length > 0 &&
    allKdsKeys.every((key) => readyItems.has(key));
  const nextReady = {
    ...currentReady,
    readyItems: [...readyItems].filter((key) => allKdsKeys.includes(key)),
    readyAt: isOrderReady ? Date.now() : null,
  };

  if (readyIndex >= 0) {
    readyOrders[readyIndex] = nextReady;
  } else {
    readyOrders.unshift(nextReady);
  }

  writeKdsReadyOrders(readyOrders);
  const cardapioResult = isOrderReady
    ? await notifyCardapioOrderReadySafely(order)
    : { ok: true, action: "cardapio-not-called", message: "Ainda existem produtos pendentes no KDS." };

  if (isOrderReady) {
    recordSystemEvent({ order: order.number, orderId: order.orderId, source }, cardapioResult);

    if (!cardapioResult.ok) {
      const failedReadyOrders = readKdsReadyOrders();
      const failedReadyIndex = failedReadyOrders.findIndex((item) => isSameOrder(item, order));

      if (failedReadyIndex >= 0) {
        failedReadyOrders[failedReadyIndex] = {
          ...failedReadyOrders[failedReadyIndex],
          readyAt: null,
        };
        writeKdsReadyOrders(failedReadyOrders);
      }

      return {
        ok: false,
        action: "cardapio-ready-failed",
        order: order.number,
        itemKeys: targetKeys,
        message: cardapioResult.message || "Nao foi possivel marcar pronto no Cardapio Web.",
        cardapio: cardapioResult,
      };
    }
  }

  return {
    ok: true,
    action: isOrderReady ? "ready" : "item-ready",
    order: order.number,
    itemKeys: targetKeys,
    cardapio: cardapioResult,
  };
}

async function markKdsOrderReady(target) {
  return withOrderLock(target, () => saveKdsReadyItems(target, "kds-ready"));
}

async function markKdsItemReady(target) {
  return withOrderLock(target, () => saveKdsReadyItems(target, "kds-item-ready"));
}

function markKdsOrderReadyFromCardapio(order) {
  const productionKeys = productionItemKeys(order);
  const allKdsKeys = dispatchableItemKeys(order);
  const externalReadyKeys = allKdsKeys.filter((key) => !productionKeys.includes(key));
  const keysFromCardapio = externalReadyKeys.length > 0 ? externalReadyKeys : allKdsKeys;

  const readyOrders = readKdsReadyOrders();
  const readyIndex = readyOrders.findIndex((item) => isSameOrder(item, order));
  const currentReady = readyIndex >= 0 ? readyOrders[readyIndex] : {};
  const readyItems = new Set(currentReady.readyItems || []);
  keysFromCardapio.forEach((key) => readyItems.add(key));
  const isOrderReady = allKdsKeys.length > 0 && allKdsKeys.every((key) => readyItems.has(key));
  const readyOrder = {
    ...currentReady,
    number: order.number,
    orderId: order.orderId,
    customer: order.customer,
    readyItems: [...readyItems].filter((key) => allKdsKeys.includes(key)),
    readyAt: isOrderReady ? Date.now() : null,
  };

  if (readyIndex >= 0) {
    readyOrders[readyIndex] = readyOrder;
  } else {
    readyOrders.unshift(readyOrder);
  }

  writeKdsReadyOrders(readyOrders);

  return {
    ok: true,
    action: isOrderReady ? "cardapio-ready-synced" : "cardapio-partial-ready-synced",
    order: order.number,
  };
}

function recordDispatchedOrder(order, payload) {
  const dispatchedOrders = readDispatchedOrders();
  const dispatchedOrder = {
    number: order.number,
    orderId: order.orderId,
    customer: order.customer || "Cliente",
    fulfillmentType: order.fulfillmentType,
    neighborhood:
      order.fulfillmentType === "pickup" ||
      order.neighborhood === "Bairro nao informado"
        ? ""
        : order.neighborhood,
    city: order.fulfillmentType === "pickup" ? "" : order.city || "",
    eventType: payload.eventType || payload.action || "",
    driverId: payload.driver?.id || "",
    driverName: payload.driver?.name || "",
    dispatchedAt: Date.now(),
  };
  const withoutDuplicate = dispatchedOrders.filter((item) =>
    item.number !== dispatchedOrder.number &&
    item.orderId !== dispatchedOrder.orderId
  );

  withoutDuplicate.unshift(dispatchedOrder);
  writeDispatchedOrders(withoutDuplicate);
}

function removeDispatchedOrder(order) {
  const dispatchedOrders = readDispatchedOrders();
  const remainingOrders = dispatchedOrders.filter((item) => !isSameOrder(item, order));

  if (remainingOrders.length !== dispatchedOrders.length) {
    writeDispatchedOrders(remainingOrders);
  }
}

function removeKdsReadyOrder(order) {
  const readyOrders = readKdsReadyOrders().filter((item) => !isSameOrder(item, order));
  writeKdsReadyOrders(readyOrders);
}

function cardapioStatusUrl(order, statusAction) {
  const orderURL = cardapioOrderUrl(order).replace(/\/$/, "");
  const endpoint = statusAction === "pickup-ready" ? "readyForPickup" : "dispatch";

  return `${orderURL}/${endpoint}`;
}

async function notifyCardapioDispatch(order, action) {
  if (String(order.orderId || "").startsWith("teste-")) {
    return {
      ok: true,
      action: action === "pickup-ready" ? "local-test-ready-for-pickup" : "local-test-dispatch",
      order: order.number,
      dispatchAction: action,
      message: "Pedido teste despachado apenas no localhost.",
    };
  }

  const statusURL = cardapioStatusUrl(order, action);
  const token = await getCardapioToken(statusURL);
  const response = await fetch(statusURL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${statusURL} retornou HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }

  return {
    ok: true,
    action: action === "pickup-ready" ? "cardapio-ready-for-pickup" : "cardapio-dispatch",
    order: order.number,
    dispatchAction: action,
  };
}

async function notifyCardapioDispatchSafely(order, action) {
  try {
    return await notifyCardapioDispatch(order, action);
  } catch (error) {
    return {
      ok: false,
      action: action === "pickup-ready" ? "cardapio-ready-for-pickup-failed" : "cardapio-dispatch-failed",
      order: order.number,
      dispatchAction: action,
      message: error.message,
    };
  }
}

async function dispatchKdsReadyOrder(target) {
  return withOrderLock(target, async () => {
  const orders = readOrders();
  const orderIndex = orders.findIndex((item) => isSameOrder(item, target));
  const order = orders[orderIndex];

  if (!order) {
    return { ok: false, message: "Pedido pronto nao encontrado." };
  }

  const readyOrder = readKdsReadyOrders().find((item) => isSameOrder(item, order));

  if (!readyOrder?.readyAt) {
    return { ok: false, message: "Pedido ainda nao esta totalmente pronto." };
  }

  const action = target.action === "pickup-ready" ? "pickup-ready" : "dispatch";
  const eventType = action === "pickup-ready" ? "READY_FOR_PICKUP" : "DISPATCHED";
  const driver = action === "dispatch" ? driverFromPayload(target) : null;

  if (action === "dispatch" && !driver) {
    return { ok: false, message: "Selecione um motoboy para despachar a entrega." };
  }

  const cardapioResult = await notifyCardapioDispatchSafely(order, action);
  recordSystemEvent(
    { order: order.number, orderId: order.orderId, source: "kds-dispatch", action, driverName: driver?.name || "" },
    cardapioResult
  );

  if (!cardapioResult.ok) {
    return {
      ok: false,
      message: cardapioResult.message || "Nao foi possivel atualizar o Cardapio Web.",
      action,
      order: order.number,
      cardapio: cardapioResult,
    };
  }

  orders.splice(orderIndex, 1);
  writeOrders(orders);
  removeKdsReadyOrder(order);
  recordDispatchedOrder(order, { action, eventType, driver });

  return {
    ok: true,
    action,
    order: order.number,
    cardapio: cardapioResult,
  };
  });
}

function readJsonFile(filePath) {
  const key = storageKeyFromFile(filePath);

  if (storageMode === "postgres" && storageReady && key && storageCache.has(key)) {
    return cloneJson(storageCache.get(key));
  }

  return readJsonFileDirect(filePath);
}

function readJsonFileDirect(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    const fallback = defaultJsonValue(filePath);
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;

    try {
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, corruptPath);
      }
      writeJsonFileDirect(filePath, fallback);
    } catch (writeError) {
      return fallback;
    }

    return fallback;
  }
}

function formatLocalDateTime(value = Date.now()) {
  return new Date(value).toLocaleString("pt-BR", {
    timeZone: APP_TIME_ZONE,
  });
}

function formatLocalTime(value = Date.now()) {
  return new Date(value).toLocaleTimeString("pt-BR", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function compactEventValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > MAX_EVENT_LOG_TEXT
      ? `${value.slice(0, MAX_EVENT_LOG_TEXT)}...`
      : value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (depth >= 4) {
    return Array.isArray(value) ? `[${value.length} item(s)]` : "{...}";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => compactEventValue(item, depth + 1));
  }

  return Object.entries(value)
    .slice(0, MAX_EVENT_LOG_KEYS)
    .reduce((compact, [key, item]) => {
      compact[key] = compactEventValue(item, depth + 1);
      return compact;
    }, {});
}

function compactEventRecord(record) {
  return compactEventValue(record);
}

function recordEvent(request, body, result) {
  const events = readEvents();
  const eventRecord = {
    receivedAt: formatLocalDateTime(),
    method: request.method,
    path: request.url,
    result: compactEventRecord(result),
    body: compactEventRecord(body),
  };

  events.unshift(eventRecord);

  writeEvents(events);
  console.log("Webhook recebido:", JSON.stringify(eventRecord));
}

function recordSystemEvent(body, result) {
  const events = readEvents();
  const eventRecord = {
    receivedAt: formatLocalDateTime(),
    method: "SYSTEM",
    path: "/sync-open-orders",
    result: compactEventRecord(result),
    body: compactEventRecord(body),
  };

  events.unshift(eventRecord);

  writeEvents(events);
  console.log("Sincronizacao:", JSON.stringify(eventRecord));
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": contentTypes[".json"] });
  response.end(JSON.stringify(data));
}

function parseCookies(request) {
  return String(request.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const separatorIndex = item.indexOf("=");

      if (separatorIndex < 0) {
        return cookies;
      }

      cookies[item.slice(0, separatorIndex)] = decodeURIComponent(item.slice(separatorIndex + 1));
      return cookies;
    }, {});
}

function panelAuthToken() {
  return crypto
    .createHmac("sha256", PANEL_SESSION_SECRET)
    .update(PANEL_PASSWORD)
    .digest("hex");
}

function isPanelAuthenticated(request) {
  return parseCookies(request)[PANEL_AUTH_COOKIE] === panelAuthToken();
}

function panelAuthCookie(value, request) {
  const secure = process.env.RENDER || request.headers["x-forwarded-proto"] === "https";
  const parts = [
    `${PANEL_AUTH_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${PANEL_AUTH_MAX_AGE_SECONDS}`,
  ];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function clearPanelAuthCookie(request) {
  return panelAuthCookie("", request).replace(`Max-Age=${PANEL_AUTH_MAX_AGE_SECONDS}`, "Max-Age=0");
}

function isPublicRoute(request, url) {
  return (
    url.pathname === "/login" ||
    url.pathname === "/api/login" ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/api/webhook/cardapio-web"
  );
}

function serveLoginPage(response, { invalid = false } = {}) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Acesso La Qualite</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        background: #0b1018;
        color: #f7f9fc;
        font-family: "Segoe UI", Arial, Helvetica, sans-serif;
      }
      form {
        width: min(420px, 100%);
        display: grid;
        gap: 14px;
        padding: 28px;
        border: 1px solid #2b3546;
        border-radius: 16px;
        background: #151a24;
        box-shadow: 0 18px 44px rgba(0, 0, 0, 0.28);
      }
      span {
        color: #b3bfd0;
        font-size: 13px;
        font-weight: 800;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: 30px;
        line-height: 1.05;
      }
      label {
        display: grid;
        gap: 8px;
      }
      input {
        width: 100%;
        min-height: 48px;
        padding: 0 14px;
        border: 1px solid #3d4a5f;
        border-radius: 10px;
        background: #111824;
        color: #f7f9fc;
        font: inherit;
        font-size: 18px;
        font-weight: 800;
      }
      button {
        min-height: 48px;
        border: 0;
        border-radius: 10px;
        background: #f7f9fc;
        color: #101318;
        cursor: pointer;
        font: inherit;
        font-size: 18px;
        font-weight: 900;
      }
      p {
        min-height: 20px;
        margin: 0;
        color: #ff565d;
        font-size: 14px;
        font-weight: 800;
      }
    </style>
  </head>
  <body>
    <form id="login-form">
      <div>
        <span>La Qualite Delivery</span>
        <h1>Acesso ao painel</h1>
      </div>
      <label>
        <span>Senha</span>
        <input id="password" type="password" autocomplete="current-password" autofocus />
      </label>
      <button type="submit">Entrar</button>
      <p id="message">${invalid ? "Senha incorreta." : ""}</p>
    </form>
    <script>
      const form = document.querySelector("#login-form");
      const password = document.querySelector("#password");
      const message = document.querySelector("#message");

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        message.textContent = "";

        const response = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: password.value }),
        });

        if (response.ok) {
          window.location.href = "/";
          return;
        }

        message.textContent = "Senha incorreta.";
        password.select();
      });
    </script>
  </body>
</html>`);
}

async function handleLogin(request, response) {
  try {
    const body = await readBody(request);

    if (String(body.password || "") !== PANEL_PASSWORD) {
      sendJson(response, 401, { ok: false, message: "Senha incorreta." });
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[".json"],
      "Set-Cookie": panelAuthCookie(panelAuthToken(), request),
    });
    response.end(JSON.stringify({ ok: true }));
  } catch (error) {
    sendJson(response, 400, { ok: false, message: "Login invalido." });
  }
}

function requirePanelAuth(request, response, url) {
  if (isPublicRoute(request, url) || isPanelAuthenticated(request)) {
    return true;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(response, 401, { ok: false, message: "Acesso protegido por senha." });
    return false;
  }

  serveLoginPage(response);
  return false;
}

function memorySnapshot() {
  const memory = process.memoryUsage();

  return {
    rssMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
  };
}

function healthSnapshot() {
  const memory = maintainMemoryPressure();

  return {
    ok: true,
    storage: storageMode,
    storageReady,
    storageError,
    updatedAt: formatLocalDateTime(),
    uptimeSeconds: Math.floor(process.uptime()),
    pendingOrderActions: orderLocks.size,
    pendingStorageWrites: storageWriteQueues.size,
    connectedScreens: eventClients.size,
    memory,
    orders: readOrders().length,
    readyOrders: ENABLE_KDS ? readKdsReadyOrders().length : 0,
    dispatchedOrders: readDispatchedOrders().length,
    drivers: readDrivers().length,
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodySize = 0;
    let finished = false;

    function finishWithError(error) {
      if (finished) {
        return;
      }

      finished = true;
      reject(error);
    }

    request.on("data", (chunk) => {
      if (finished) {
        return;
      }

      bodySize += chunk.length;

      if (bodySize > MAX_REQUEST_BODY_BYTES) {
        finishWithError(new Error("Corpo da requisicao muito grande."));
        request.destroy();
        return;
      }

      body += chunk;
    });

    request.on("end", () => {
      if (finished) {
        return;
      }

      finished = true;

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

    request.on("error", finishWithError);
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

function textFromValue(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(textFromValue).filter(Boolean).join(" ");
  }

  if (typeof value === "object") {
    return String(getDeepValue(value, [
      "name",
      "title",
      "description",
      "label",
      "nome",
      "categoryName",
    ]) || Object.values(value).map(textFromValue).filter(Boolean).join(" "));
  }

  return "";
}

function searchTextFromValue(value, depth = 0) {
  if (!value || depth > 5) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => searchTextFromValue(item, depth + 1)).filter(Boolean).join(" ");
  }

  if (typeof value === "object") {
    return Object.values(value)
      .map((item) => searchTextFromValue(item, depth + 1))
      .filter(Boolean)
      .join(" ");
  }

  return "";
}

function categoryNameFromObject(value) {
  return textFromValue(getDeepValue(value, [
    "category.name",
    "categoryName",
    "category_name",
    "categoryTitle",
    "category_title",
    "productCategoryName",
    "product_category_name",
    "parentCategoryName",
    "parent_category_name",
    "name",
    "title",
    "description",
    "label",
    "nome",
  ]));
}

function buildCategoryLookup(source) {
  const categories = new Map();
  const queue = [source];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }

    seen.add(current);

    const id = getDeepValue(current, ["id", "categoryId", "categoryID", "uuid", "code", "codigo"]);
    const name = categoryNameFromObject(current);

    if (id && name && sectorFromCategory(normalizeText(name))) {
      categories.set(String(id), name);
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return categories;
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
        const parentCategory = textFromValue(getDeepValue(current, [
          "category.name",
          "category",
          "categoryName",
          "name",
          "title",
          "description",
          "group.name",
          "group",
          "nome",
        ]));

        return value.map((item) => ({
          ...item,
          _parentCategory: item._parentCategory || parentCategory,
        }));
      }

      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return [];
}

function categoryIdsFromItem(item) {
  const values = [
    getDeepValue(item, [
      "categoryIds",
      "categoryIDs",
      "category_ids",
      "categoriesIds",
      "categories_ids",
      "categories.id",
      "categories.uuid",
      "product.categoryIds",
      "product.category_ids",
      "product.categories.id",
      "item.categoryIds",
      "item.category_ids",
      "item.categories.id",
    ]),
    getDeepValue(item, [
      "categoryId",
      "categoryID",
      "category_id",
      "category.id",
      "category.uuid",
      "category.code",
      "groupId",
      "group_id",
      "group.id",
      "sectionId",
      "section_id",
      "section.id",
      "product.categoryId",
      "product.categoryID",
      "product.category_id",
      "product.category.id",
      "product.groupId",
      "product.group_id",
      "productCategoryId",
      "product_category_id",
      "item.categoryId",
      "item.category_id",
      "item.category.id",
      "produto.categoria.id",
    ]),
    findValueByKeyNames(item, [
      "categoryIds",
      "categoryIDs",
      "category_ids",
      "categoriesIds",
      "categories_ids",
      "categoryId",
      "categoryID",
      "category_id",
    ]),
  ];

  return [...new Set(values.flatMap((value) => {
    if (!value) {
      return [];
    }

    if (Array.isArray(value)) {
      return value.map((itemValue) => {
        if (itemValue && typeof itemValue === "object") {
          return getDeepValue(itemValue, ["id", "uuid", "code", "categoryId", "category_id"]) || "";
        }

        return itemValue;
      });
    }

    return [value];
  }).map(normalizeExternalId).filter(Boolean))];
}

function categoryIdFromItem(item) {
  const categoryId = getDeepValue(item, [
    "categoryId",
    "categoryID",
    "category_id",
    "category.id",
    "category.uuid",
    "category.code",
    "groupId",
    "group_id",
    "group.id",
    "sectionId",
    "section_id",
    "section.id",
    "product.categoryId",
    "product.categoryID",
    "product.category_id",
    "product.category.id",
    "product.groupId",
    "product.group_id",
    "productCategoryId",
    "product_category_id",
    "item.categoryId",
    "item.category_id",
    "item.category.id",
    "produto.categoria.id",
  ]);

  return categoryId ? String(categoryId) : "";
}

function categoryTextFromItem(item, categoryLookup) {
  const directCategory = textFromValue(getDeepValue(item, [
    "category.name",
    "category",
    "categoryName",
    "category_name",
    "categoryTitle",
    "category_title",
    "categories",
    "categories.name",
    "section.name",
    "section",
    "sector.name",
    "sector",
    "department.name",
    "department",
    "group.name",
    "group",
    "product.category.name",
    "product.category",
    "product.categoryName",
    "product.category_name",
    "productCategoryName",
    "product_category_name",
    "product.categories",
    "item.category.name",
    "item.category",
    "item.categoryName",
    "item.category_name",
    "parentCategoryName",
    "parent_category_name",
    "produto.categoria.nome",
    "_parentCategory",
  ]));

  if (directCategory) {
    return directCategory;
  }

  const categoryId = categoryIdFromItem(item);
  return categoryId ? categoryLookup.get(categoryId) || "" : "";
}

function pdvCodesFromItem(item) {
  const values = [
    getDeepValue(item, [
      "pdvCode",
      "pdv_code",
      "codigoPdv",
      "codigoPDV",
      "codigo_pdv",
      "product.pdvCode",
      "product.pdv_code",
      "product.codigoPdv",
      "product.codigoPDV",
      "product.codigo_pdv",
      "item.pdvCode",
      "item.pdv_code",
      "code",
      "codigo",
      "product.code",
      "product.codigo",
      "item.code",
      "item.codigo",
      "option.code",
      "option.codigo",
      "option.product.code",
      "option.product.codigo",
      "posCode",
      "pos_code",
      "product.posCode",
      "product.pos_code",
      "item.posCode",
      "item.pos_code",
      "plu",
      "PLU",
      "product.plu",
      "product.PLU",
      "item.plu",
      "item.PLU",
      "sku",
      "SKU",
      "product.sku",
      "product.SKU",
      "item.sku",
      "productCode",
      "product_code",
      "product.productCode",
      "product.product_code",
      "externalCode",
      "external_code",
      "product.externalCode",
      "product.external_code",
      "internalCode",
      "internal_code",
      "product.internalCode",
      "product.internal_code",
      "integrationCode",
      "integration_code",
      "product.integrationCode",
      "product.integration_code",
      "reference",
      "product.reference",
      "referencia",
      "product.referencia",
    ]),
    findValueByKeyNames(item, [
      "pdvCode",
      "pdv_code",
      "codigoPdv",
      "codigoPDV",
      "codigo_pdv",
      "code",
      "codigo",
      "posCode",
      "pos_code",
      "plu",
      "PLU",
      "sku",
      "productCode",
      "product_code",
      "externalCode",
      "external_code",
      "internalCode",
      "internal_code",
      "integrationCode",
      "integration_code",
      "reference",
      "referencia",
    ]),
  ];

  return [...new Set(values.map(normalizePdvCode).filter(Boolean))];
}

function normalizeOrderItems(order) {
  const categoryLookup = buildCategoryLookup(order);

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

      const category = categoryTextFromItem(item, categoryLookup);
      const complements = normalizeComplements(item);
      const pdvCodes = pdvCodesFromItem(item);
      const categoryIds = categoryIdsFromItem(item);
      const normalizedItem = {
        name,
        quantity: toNumber(getDeepValue(item, [
          "quantity",
          "qty",
          "amount",
          "count",
          "quantidade",
        ])),
        category,
        notes: extractNoteText(item),
        complements,
        pdvCodes,
        categoryIds,
        searchText: searchTextFromValue(item),
      };

      return {
        ...normalizedItem,
        sectors: sectorKeysForItem(normalizedItem),
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
            category: categoryTextFromItem(nestedItem, new Map()),
            pdvCodes: pdvCodesFromItem(nestedItem),
            categoryIds: categoryIdsFromItem(nestedItem),
            searchText: searchTextFromValue(nestedItem),
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
        category: categoryTextFromItem(complement, new Map()),
        pdvCodes: pdvCodesFromItem(complement),
        categoryIds: categoryIdsFromItem(complement),
        searchText: searchTextFromValue(complement),
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

function cardapioPartnerApiKey() {
  return CARDAPIO_API_KEY;
}

function cardapioPartnerHeaders() {
  const headers = {
    Accept: "application/json",
    "X-API-KEY": cardapioPartnerApiKey(),
  };

  if (CARDAPIO_PARTNER_KEY) {
    headers["X-PARTNER-KEY"] = CARDAPIO_PARTNER_KEY;
  }

  return headers;
}

async function fetchCardapioPartnerJson(url, options = {}) {
  const apiKey = cardapioPartnerApiKey();

  if (!apiKey) {
    throw new Error("CARDAPIO_API_KEY nao configurado no Render.");
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      ...cardapioPartnerHeaders(),
      ...(options.headers || {}),
    },
  });

  if (response.status === 204) {
    return null;
  }

  const responseText = await response.text();

  if (!response.ok) {
    const hint = response.status === 401
      ? " Verifique CARDAPIO_API_KEY no Render."
      : "";
    throw new Error(
      `${url} retornou HTTP ${response.status}.${hint}${responseText ? ` ${responseText.slice(0, 200)}` : ""}`
    );
  }

  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `Cardapio Web retornou uma pagina em vez de JSON no polling oficial. Inicio da resposta: ${responseText.slice(0, 120)}`
    );
  }
}

function partnerOrdersPollingUrl() {
  const url = new URL(CARDAPIO_PARTNER_ORDERS_URL);

  if (partnerOrdersLastSuccessfulSyncAt) {
    const overlapMs = 2 * 60 * 1000;
    url.searchParams.set("updated_since", new Date(partnerOrdersLastSuccessfulSyncAt - overlapMs).toISOString());
  }

  return url.toString();
}

function partnerOrderId(order) {
  return String(getDeepValue(order, [
    "id",
    "order_id",
    "orderId",
    "orderID",
  ]) || "");
}

function partnerOrderStatusKind(order) {
  const status = String(getDeepValue(order, ["status", "orderStatus", "situacao"]) || "").toLowerCase();

  if (status === "released") {
    return "dispatched";
  }

  if ([
    "canceled",
    "cancelled",
    "canceling",
    "closed",
    "delivered",
    "finished",
    "completed",
    "concluded",
  ].includes(status)) {
    return "closed";
  }

  return "active";
}

async function syncPartnerModifiedOrders() {
  if (partnerOrdersSyncInFlight) {
    return partnerOrdersSyncInFlight;
  }

  partnerOrdersSyncInFlight = (async () => {
    const payload = await fetchCardapioPartnerJson(partnerOrdersPollingUrl());
    const changedOrders = extractOrdersList(payload).slice(0, 220);
    const processedOrders = [];
    const failedOrders = [];

    for (const changedOrder of changedOrders) {
      const orderId = partnerOrderId(changedOrder);

      if (!orderId) {
        continue;
      }

      try {
        const statusKind = partnerOrderStatusKind(changedOrder);

        if (statusKind === "closed") {
          const normalized = normalizeOrder(changedOrder) || { orderId, number: orderId };
          removeDispatchedOrder(normalized);
          if (ENABLE_KDS) {
            removeKdsReadyOrder(normalized);
          }
          writeOrders(readOrders().filter((order) => !isSameOrder(order, normalized)));
          processedOrders.push(orderId);
          continue;
        }

        if (statusKind === "dispatched") {
          const detailUrl = `${CARDAPIO_PARTNER_ORDERS_URL.replace(/\/$/, "")}/${encodeURIComponent(orderId)}`;
          const details = await fetchCardapioPartnerJson(detailUrl);
          const normalized = normalizeOrder(details || changedOrder) || normalizeOrder(changedOrder);

          if (normalized) {
            writeOrders(readOrders().filter((order) => !isSameOrder(order, normalized)));
            if (ENABLE_KDS) {
              removeKdsReadyOrder(normalized);
            }
            recordDispatchedOrder(normalized, {
              eventType: String(getDeepValue(changedOrder, ["status"]) || "").toUpperCase(),
            });
            processedOrders.push(orderId);
            continue;
          }
        }

        const detailUrl = `${CARDAPIO_PARTNER_ORDERS_URL.replace(/\/$/, "")}/${encodeURIComponent(orderId)}`;
        const details = await fetchCardapioPartnerJson(detailUrl);
        const result = await handleWebhook(details || changedOrder);

        if (result.ok) {
          processedOrders.push(orderId);
        } else {
          failedOrders.push({ orderId, message: result.message || "Pedido nao processado." });
        }
      } catch (error) {
        failedOrders.push({ orderId, message: error.message });
      }
    }

    partnerOrdersLastSuccessfulSyncAt = Date.now();

    return {
      ok: true,
      action: "partner-orders-polled",
      count: changedOrders.length,
      processed: processedOrders.length,
      failed: failedOrders.length,
    };
  })();

  try {
    return await partnerOrdersSyncInFlight;
  } finally {
    partnerOrdersSyncInFlight = null;
  }
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
  const syncedAt = Date.now();

  return extractOrdersList(payload)
    .map(normalizeOrder)
    .filter(Boolean)
    .filter(isOpenOrder)
    .map((order) => {
      const previous = previousByOrderId.get(String(order.orderId));

      return {
        ...order,
        arrivedAt: previous?.arrivedAt || order.arrivedAt,
        lastSeenOpenAt: syncedAt,
        items: order.items?.length ? order.items : previous?.items || [],
      };
    });
}

function testOrderItem(kind, index) {
  const items = {
    pizza: {
      name: index % 2 === 0 ? "Pizza Calabresa" : "PIZZAS BROTO - 1 SABOR",
      quantity: 1,
      category: "PIZZAS SALGADAS - TODOS OS SABORES",
      complements: [
        { name: index % 2 === 0 ? "Calabresa" : "Bauru", quantity: 1 },
        { name: "Nao enviar KETCHUP", quantity: 1 },
      ],
      notes: index % 5 === 0 ? "Caprichar na borda" : "",
      pdvCodes: ["PIZZA"],
      categoryIds: ["pizza"],
    },
    esfiha: {
      name: index % 3 === 0 ? "Combo 4" : "Esfihas Especiais",
      quantity: index % 3 === 0 ? 2 : 3,
      category: "ESFIHAS & COMBOS",
      complements: [
        { name: index % 3 === 0 ? "Coca Cola 1,5 ZERO" : "Calabresa Com Queijo", quantity: 1 },
        { name: "Nao enviar KETCHUP", quantity: 1 },
      ],
      notes: "",
      pdvCodes: [index % 3 === 0 ? "COMBO4" : "ESFIHAESP"],
      categoryIds: ["esfihas"],
    },
    porcao: {
      name: index % 2 === 0 ? "Fritas 400G" : "Suco Polpas Natural",
      quantity: 1,
      category: index % 2 === 0 ? "PORCOES" : "SUCOS",
      complements: [
        { name: index % 2 === 0 ? "Nao enviar KETCHUP" : "Acerola 1L", quantity: 1 },
      ],
      notes: index % 4 === 0 ? "Separar bem embalado" : "",
      pdvCodes: [index % 2 === 0 ? "PORCAOFRITAS" : "SUCO"],
      categoryIds: [index % 2 === 0 ? "porcoes" : "sucos"],
    },
  };
  const item = items[kind] || items.pizza;

  return {
    ...item,
    sectors: sectorKeysForItem(item),
    searchText: `${item.category} ${item.name}`,
  };
}

function testOrderItems(index) {
  if (index % 4 === 0) return [testOrderItem("pizza", index)];
  if (index % 4 === 1) return [testOrderItem("esfiha", index)];
  if (index % 4 === 2) return [testOrderItem("porcao", index)];

  return [
    testOrderItem("pizza", index),
    testOrderItem("esfiha", index),
    testOrderItem("porcao", index),
  ];
}

function createTestOrders(payload = {}) {
  const count = Math.min(Math.max(Number(payload.count || 50), 1), 80);
  const now = Date.now();
  const neighborhoods = ["Centro", "Vila Nova", "Parque Industrial", "Moreira", "Jardim Renascenca"];
  const orders = readOrders().filter((order) => !isTestOrderRecord(order));
  const testOrders = Array.from({ length: count }, (_, index) => {
    const number = 9001 + index;
    const isPickup = index % 5 === 0;

    return {
      number: String(number),
      orderId: `teste-carga-${number}`,
      loadTest: true,
      customer: `Teste ${String(index + 1).padStart(2, "0")}`,
      phone: "",
      fulfillmentType: isPickup ? "pickup" : "delivery",
      neighborhood: isPickup ? "" : neighborhoods[index % neighborhoods.length],
      city: isPickup ? "" : "Mirassol",
      address: isPickup ? "" : `Rua Teste, ${100 + index}`,
      arrivedAt: now - index * 45000,
      lastSeenOpenAt: now,
      total: 0,
      payment: "Teste",
      notes: "Pedido teste de carga",
      items: testOrderItems(index),
      orderURL: `/api/test-orders/${number}`,
    };
  });

  writeOrders([...orders, ...testOrders]);
  writeKdsReadyOrders(readKdsReadyOrders().filter((order) => !isTestOrderRecord(order)));
  writeDispatchedOrders(readDispatchedOrders().filter((order) => !isTestOrderRecord(order)));
  recordSystemEvent({ source: "monitor", test: true, count }, {
    ok: true,
    action: "test-orders-created",
    count,
  });

  return { ok: true, action: "test-orders-created", count };
}

function clearTestOrders() {
  const orders = readOrders();
  const readyOrders = readKdsReadyOrders();
  const dispatchedOrders = readDispatchedOrders();
  const nextOrders = orders.filter((order) => !isTestOrderRecord(order));
  const nextReadyOrders = readyOrders.filter((order) => !isTestOrderRecord(order));
  const nextDispatchedOrders = dispatchedOrders.filter((order) => !isTestOrderRecord(order));
  const count =
    orders.length - nextOrders.length +
    readyOrders.length - nextReadyOrders.length +
    dispatchedOrders.length - nextDispatchedOrders.length;

  writeOrders(nextOrders);
  writeKdsReadyOrders(nextReadyOrders);
  writeDispatchedOrders(nextDispatchedOrders);
  recordSystemEvent({ source: "monitor", test: true }, {
    ok: true,
    action: "test-orders-cleared",
    count,
  });

  return { ok: true, action: "test-orders-cleared", count };
}

function extractEventsList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  return (
    payload.events ||
    payload.items ||
    payload.data?.events ||
    payload.data?.items ||
    payload.data ||
    payload.content ||
    []
  );
}

function cardapioEventsAckUrl() {
  if (CARDAPIO_EVENTS_ACK_URL) {
    return CARDAPIO_EVENTS_ACK_URL;
  }

  if (CARDAPIO_EVENTS_URL.includes("events:polling")) {
    return CARDAPIO_EVENTS_URL.replace("events:polling", "events/acknowledgment");
  }

  return `${CARDAPIO_EVENTS_URL.replace(/\/$/, "")}/acknowledgment`;
}

function acknowledgmentPayloadForEvent(event) {
  const eventId = event.eventId || event.id;

  if (!eventId || !event.orderId || !event.eventType) {
    return null;
  }

  return {
    id: String(eventId),
    orderId: String(event.orderId),
    eventType: String(event.eventType).toUpperCase(),
  };
}

async function acknowledgeCardapioEvents(events) {
  const acknowledgments = events
    .map(acknowledgmentPayloadForEvent)
    .filter(Boolean);

  if (!acknowledgments.length) {
    return { ok: true, action: "ack-skipped", count: 0 };
  }

  const ackUrl = cardapioEventsAckUrl();
  const token = await getCardapioToken(ackUrl);
  const response = await fetch(ackUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(acknowledgments),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Falha ao confirmar eventos do Cardapio Web: HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`
    );
  }

  return { ok: true, action: "acknowledged", count: acknowledgments.length };
}

async function syncOpenOrderEvents() {
  const token = await getCardapioToken(CARDAPIO_EVENTS_URL);
  const response = await fetch(CARDAPIO_EVENTS_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (response.status === 204) {
    return {
      ok: true,
      action: "events-polled",
      count: 0,
      acknowledged: 0,
    };
  }

  if (!response.ok) {
    throw new Error(`Falha ao consultar eventos do Cardapio Web: HTTP ${response.status}`);
  }

  const responseText = await response.text();
  let payload = null;

  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `Falha ao consultar eventos do Cardapio Web: retornou uma pagina em vez de JSON. Verifique CARDAPIO_EVENTS_URL no Render. Inicio da resposta: ${responseText.slice(0, 120)}`
    );
  }

  const events = extractEventsList(payload);
  const processedEvents = [];
  const failedEvents = [];

  for (const event of events) {
    try {
      const result = await handleWebhook(event);

      if (result.ok) {
        processedEvents.push(event);
      } else {
        failedEvents.push({ event, message: result.message || "Evento nao processado." });
      }
    } catch (error) {
      failedEvents.push({ event, message: error.message });
    }
  }

  const ackResult = await acknowledgeCardapioEvents(processedEvents);

  if (failedEvents.length) {
    recordSystemEvent(
      { source: CARDAPIO_EVENTS_URL, failed: failedEvents.length },
      {
        ok: false,
        action: "events-partial-failed",
        message: `${failedEvents.length} evento(s) nao foram confirmados para tentar novamente depois.`,
      }
    );
  }

  return {
    ok: true,
    action: "events-polled",
    count: events.length,
    processed: processedEvents.length,
    acknowledged: ackResult.count,
    failed: failedEvents.length,
  };
}

async function performSyncOpenOrders() {
  const results = [];
  const errors = [];

  if (CARDAPIO_CLIENT_ID && CARDAPIO_CLIENT_SECRET) {
    try {
      results.push(await syncOpenOrderEvents());
    } catch (error) {
      errors.push({ source: "events", message: error.message });
    }
  }

  if (cardapioPartnerApiKey()) {
    try {
      results.push(await syncPartnerModifiedOrders());
    } catch (error) {
      errors.push({ source: "partner-orders", message: error.message });
    }
  }

  if (!results.length && !errors.length) {
    return {
      ok: true,
      action: "sync-skipped",
      message: "Credenciais do Cardapio Web nao configuradas.",
    };
  }

  const count = results.reduce((total, result) => total + Number(result.count || 0), 0);
  const processed = results.reduce((total, result) => total + Number(result.processed || 0), 0);
  const failed = results.reduce((total, result) => total + Number(result.failed || 0), 0) + errors.length;

  return {
    ok: errors.length === 0,
    action: errors.length ? "sync-partial" : "sync-completed",
    count,
    processed,
    failed,
    results,
    errors,
    message: errors.map((error) => `${error.source}: ${error.message}`).join(" | "),
  };
}

async function syncOpenOrders() {
  if (openOrdersSyncInFlight) {
    return openOrdersSyncInFlight;
  }

  openOrdersSyncInFlight = performSyncOpenOrders()
    .finally(() => {
      openOrdersSyncInFlight = null;
      maintainMemoryPressure();
    });

  return openOrdersSyncInFlight;
}

async function syncOpenOrdersSafely() {
  if ((!CARDAPIO_CLIENT_ID || !CARDAPIO_CLIENT_SECRET) && !cardapioPartnerApiKey()) {
    return;
  }

  try {
    const result = await syncOpenOrders();
    if (result.count || result.failed) {
      recordSystemEvent({ source: CARDAPIO_EVENTS_URL }, result);
    }
  } catch (error) {
    recordSystemEvent(
      { source: CARDAPIO_EVENTS_URL },
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
  const city = String(getDeepValue(order, [
    "deliveryAddress.city",
    "delivery.address.city",
    "delivery.deliveryAddress.city",
    "delivery.delivery_address.city",
    "address.city",
    "endereco.cidade",
    "customer.address.city",
    "buyer.address.city",
    "cidade",
    "city",
  ]) || findValueByKeyNames(order, [
    "cidade",
    "city",
    "cityName",
    "municipio",
  ]) || "Cidade nao informada");
  const phone = String(getDeepValue(order, [
    "customer.phone",
    "customer.phoneNumber",
    "customer.telephone",
    "customer.telefone",
    "cliente.telefone",
    "cliente.celular",
    "buyer.phone",
    "buyer.phoneNumber",
    "consumer.phone",
    "phone",
    "phoneNumber",
    "telefone",
    "celular",
  ]) || findValueByKeyNames(order, [
    "phone",
    "phoneNumber",
    "telephone",
    "telefone",
    "celular",
    "mobile",
    "whatsapp",
  ]) || "");
  const address = String(getDeepValue(order, [
    "deliveryAddress.formattedAddress",
    "deliveryAddress.fullAddress",
    "delivery.address.formattedAddress",
    "delivery.address.fullAddress",
    "delivery.deliveryAddress.formattedAddress",
    "delivery.deliveryAddress.fullAddress",
    "address.formattedAddress",
    "address.fullAddress",
    "endereco.completo",
    "customer.address.formattedAddress",
    "buyer.address.formattedAddress",
  ]) || [
    getDeepValue(order, [
      "deliveryAddress.street",
      "delivery.address.street",
      "delivery.deliveryAddress.street",
      "address.street",
      "endereco.rua",
      "street",
      "logradouro",
    ]),
    getDeepValue(order, [
      "deliveryAddress.number",
      "delivery.address.number",
      "delivery.deliveryAddress.number",
      "address.number",
      "endereco.numero",
      "number",
      "numero",
    ]),
    neighborhood,
    city,
  ].filter(Boolean).join(" "));

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
    phone,
    address,
    neighborhood: fulfillmentType === "pickup" ? "" : neighborhood,
    city: fulfillmentType === "pickup" ? "" : city,
    fulfillmentType,
    arrivedAt: parseDateToTimestamp(
      order.arrivedAt ||
        order.createdAt ||
        order.created_at ||
        order.createdAtTimestamp ||
        order.createdDateTime
    ),
    rawStatus: String(getDeepValue(order, ["status", "orderStatus", "situacao"]) || ""),
    orderURL: String(order.orderURL || order.orderUrl || order.url || payload.orderURL || payload.orderUrl || ""),
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

function itemSearchText(item) {
  const complements = (item.complements || [])
    .map((complement) => `${complement.name || ""} ${complement.category || ""} ${(complement.pdvCodes || []).join(" ")} ${(complement.categoryIds || []).join(" ")} ${complement.searchText || ""}`)
    .join(" ");

  return normalizeText(`${item.category || ""} ${item.name || ""} ${(item.pdvCodes || []).join(" ")} ${(item.categoryIds || []).join(" ")} ${item.description || ""} ${item.notes || ""} ${item.searchText || ""} ${complements}`);
}

function hasAnyTerm(text, terms) {
  return terms.some((term) => text.includes(term));
}

function sectorFromCategory(categoryText) {
  if (hasAnyTerm(categoryText, ["porcao", "porcoes", "porc", "suco", "sucos"])) {
    return { key: "porcoes", label: "Porções" };
  }

  if (hasAnyTerm(categoryText, ["esfiha", "esfihas", "esfirra", "esfirras", "sfiha", "sfihas"])) {
    return { key: "esfihas", label: "Esfihas" };
  }

  if (hasAnyTerm(categoryText, ["pizza", "pizzas"])) {
    return { key: "pizzas", label: "Pizzas" };
  }

  return null;
}

function sectorKeysForItem(item) {
  const categorySector = sectorFromCategory(normalizeText(item.category || ""));
  const text = itemSearchText(item);
  const sectors = new Set();
  const pdvCodes = [
    ...(item.pdvCodes || []),
    ...(item.complements || []).flatMap((complement) => complement.pdvCodes || []),
  ];
  const categoryIds = [
    ...(item.categoryIds || []),
    ...(item.complements || []).flatMap((complement) => complement.categoryIds || []),
  ];

  for (const sector of sectorsFromPdvCodes(pdvCodes)) {
    sectors.add(sector);
  }

  for (const sector of sectorsFromCategoryIds(categoryIds)) {
    sectors.add(sector);
  }

  if (categorySector) {
    sectors.add(categorySector.key);
  }

  if (hasAnyTerm(text, ["pizza", "pizzas"])) {
    sectors.add("pizzas");
  }

  if (hasAnyTerm(text, ["esfiha", "esfihas", "esfirra", "esfirras", "sfiha", "sfihas"])) {
    sectors.add("esfihas");
  }

  if (hasAnyTerm(text, ["porcao", "porcoes", "porc", "fritas", "batata", "mandioca", "onion", "aneis", "anel de cebola", "suco", "sucos"])) {
    sectors.add("porcoes");
  }

  if (
    sectors.size === 0 &&
    hasAnyTerm(text, ["combo 1", "combo 2", "combo 3", "combo 4", "combo de esfiha", "combo esfihas", "combo esfiha"])
  ) {
    sectors.add("esfihas");
  }

  return [...sectors];
}

function classifyProductionItem(item) {
  const categoryText = normalizeText(item.category || "");
  const text = itemSearchText(item);
  const isCombo = hasAnyTerm(text, ["combo", "combinado", "kit", "box"]);
  const categorySector = sectorFromCategory(categoryText);
  const sectors = Array.isArray(item.sectors) && item.sectors.length > 0
    ? item.sectors
    : sectorKeysForItem(item);

  if (categorySector) {
    return { ...categorySector, isCombo };
  }

  if (sectors.includes("esfihas")) {
    return { key: "esfihas", label: "Esfihas", isCombo };
  }

  if (sectors.includes("porcoes")) {
    return { key: "porcoes", label: "Porções", isCombo };
  }

  if (sectors.includes("pizzas")) {
    return { key: "pizzas", label: "Pizzas", isCombo };
  }

  if (hasAnyTerm(text, ["pizza", "pizzas"])) {
    return { key: "pizzas", label: "Pizzas", isCombo };
  }

  if (hasAnyTerm(text, ["esfiha", "esfihas", "esfirra", "esfirras", "sfiha", "sfihas"])) {
    return { key: "esfihas", label: "Esfihas", isCombo };
  }

  if (hasAnyTerm(text, ["porcao", "porcoes", "porc", "fritas", "batata", "mandioca", "onion", "aneis", "anel de cebola", "suco", "sucos"])) {
    return { key: "porcoes", label: "Porções", isCombo };
  }

  if (
    isCombo &&
    hasAnyTerm(text, ["combo 1", "combo 2", "combo 3", "combo 4", "combo de esfiha", "combo esfihas", "combo esfiha"])
  ) {
    return { key: "esfihas", label: "Esfihas", isCombo: true };
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
    updatedAt: formatLocalTime(),
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
    .filter((order) => !readyOrders.some((readyOrder) => isSameOrder(order, readyOrder) && isKdsOrderComplete(order, readyOrder)))
    .sort((a, b) => a.arrivedAt - b.arrivedAt)
    .map((order) => {
      const readyOrder = readyOrders.find((item) => isSameOrder(item, order));
      const readyItems = new Set(readyOrder?.readyItems || []);

      return {
        number: order.number,
        orderId: order.orderId,
        customer: order.customer,
        phone: order.phone || "",
        address: order.address || "",
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
          .filter((item) => isProductionKdsItem(item) && !readyItems.has(item.kdsItemKey)),
      };
    })
    .filter((order) => order.items.length > 0);
}

function buildKdsReadyOrders() {
  const orders = readOrders();
  const readyOrders = readKdsReadyOrders();
  const dispatchedOrders = readDispatchedOrders();

  return readyOrders
    .filter((readyOrder) => readyOrder.readyAt || (readyOrder.readyItems || []).length > 0)
    .filter((readyOrder) => !dispatchedOrders.some((dispatchedOrder) => isSameOrder(dispatchedOrder, readyOrder)))
    .map((readyOrder) => {
      const order = orders.find((item) => isSameOrder(item, readyOrder));

      if (!order || !Array.isArray(order.items) || order.items.length === 0) {
        return null;
      }

      return {
        number: order.number,
        orderId: order.orderId,
        customer: order.customer,
        phone: order.phone || "",
        address: order.address || "",
        fulfillmentType: order.fulfillmentType,
        neighborhood: order.neighborhood,
        arrivedAt: order.arrivedAt,
        readyAt: readyOrder.readyAt || null,
        notes: order.notes || "",
        items: order.items
          .map((item, index) => ({
            ...item,
            kdsItemKey: kdsItemKey(item, index),
            notes: item.notes || extractNoteText(item),
          }))
          .filter((item) => isDispatchableKdsItem(item))
          .filter((item) => readyOrder.readyAt || (readyOrder.readyItems || []).includes(item.kdsItemKey)),
      };
    })
    .filter(Boolean)
    .filter((order) => order.items.length > 0)
    .sort((a, b) => Number(b.readyAt || 0) - Number(a.readyAt || 0));
}

function buildKdsDebug() {
  return readOrders().map((order) => ({
    number: order.number,
    customer: order.customer,
    items: (order.items || []).map((item) => ({
      name: item.name,
      category: item.category || "",
      pdvCodes: item.pdvCodes || [],
      categoryIds: item.categoryIds || [],
      sectors: sectorKeysForItem(item),
      classification: classifyProductionItem(item).key,
      itemKeys: Object.keys(item || {}).sort(),
      productKeys: item.product && typeof item.product === "object" ? Object.keys(item.product).sort() : [],
      searchText: itemSearchText(item).slice(0, 300),
    })),
  }));
}

function kdsStatusForOrder(order, readyOrders = readKdsReadyOrders()) {
  if (order.externalReadyAt) {
    return {
      label: "Pronto",
      state: "ready",
      readyCount: 1,
      totalCount: 1,
    };
  }

  if (!ENABLE_KDS) {
    return {
      label: "Em preparo",
      state: "preparing",
      readyCount: 0,
      totalCount: 0,
    };
  }

  const productionKeys = productionItemKeys(order);

  if (productionKeys.length === 0) {
    return {
      label: "Em preparo",
      state: "preparing",
      readyCount: 0,
      totalCount: 0,
    };
  }

  const readyOrder = readyOrders.find((item) => isSameOrder(item, order));
  const readyItems = new Set(readyOrder?.readyItems || []);
  const readyCount = productionKeys.filter((key) => readyItems.has(key)).length;

  if (readyCount >= productionKeys.length) {
    return {
      label: "Pronto",
      state: "ready",
      readyCount: productionKeys.length,
      totalCount: productionKeys.length,
    };
  }

  if (readyCount > 0) {
    return {
      label: "Falta item",
      state: "partial",
      readyCount,
      totalCount: productionKeys.length,
    };
  }

  return {
    label: "Em preparo",
    state: "preparing",
    readyCount: 0,
    totalCount: productionKeys.length,
  };
}

async function syncOpenOrdersForPageLoad() {
  try {
    return await syncOpenOrders();
  } catch (error) {
    return {
      ok: false,
      action: "sync-failed",
      message: error.message,
    };
  }
}

function ordersWithKdsStatus() {
  const readyOrders = ENABLE_KDS ? readKdsReadyOrders() : [];

  return readOrders()
    .map((order) => ({
      ...order,
      kdsStatus: kdsStatusForOrder(order, readyOrders),
    }))
    .sort((a, b) => {
      const leftNumber = Number(a.number);
      const rightNumber = Number(b.number);

      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return leftNumber - rightNumber;
      }

      return Number(a.arrivedAt || 0) - Number(b.arrivedAt || 0);
    });
}

function removalEventKind(payload, normalizedOrder) {
  const eventType = String(payload.eventType || "").toUpperCase();
  const activeEventTypes = new Set(["CREATED", "CONFIRMED", "ACCEPTED", "PREPARING", "READY"]);
  const dispatchedEventTypes = new Set([
    "DISPATCHED",
    "OUT_FOR_DELIVERY",
  ]);
  const closedEventTypes = new Set([
    "DELIVERED",
    "CONCLUDED",
    "FINISHED",
    "COMPLETED",
    "CANCELED",
    "CANCELLED",
  ]);

  if (activeEventTypes.has(eventType)) {
    return "";
  }

  if (dispatchedEventTypes.has(eventType)) {
    return "dispatched";
  }

  if (closedEventTypes.has(eventType)) {
    return "closed";
  }

  const eventText = [
    payload.eventType,
    payload.event,
    payload.type,
    payload.status,
    payload.action,
    findValueByKeyNames(payload, [
      "orderStatus",
      "productionStatus",
      "kdsStatus",
      "preparationStatus",
      "statusCode",
      "situacao",
      "situacaoPedido",
    ]),
    normalizedOrder?.rawStatus,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if ([
    "dispatch",
    "dispatched",
    "despach",
    "saiu",
    "out_for_delivery",
    "out for delivery",
  ].some((word) => eventText.includes(word))) {
    return "dispatched";
  }

  if ([
    "pickedup",
    "picked_up",
    "picked up",
    "sent",
    "shipped",
    "delivered",
    "concluded",
    "finished",
    "completed",
    "cancel",
  ].some((word) => eventText.includes(word))) {
    return "closed";
  }

  return "";
}

function isProductionReadyEvent(payload, normalizedOrder) {
  const eventType = String(payload.eventType || "").toUpperCase();

  if (["READY", "ORDER_READY", "PRODUCTION_READY", "PREPARED", "PRONTO", "READY_FOR_PICKUP", "WAITING_TO_CATCH"].includes(eventType)) {
    return true;
  }

  if ([
    "DISPATCHED",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "CONCLUDED",
    "FINISHED",
    "COMPLETED",
    "CANCELED",
    "CANCELLED",
  ].includes(eventType)) {
    return false;
  }

  const eventText = [
    payload.eventType,
    payload.event,
    payload.type,
    payload.status,
    payload.action,
    findValueByKeyNames(payload, [
      "orderStatus",
      "productionStatus",
      "kdsStatus",
      "preparationStatus",
      "statusCode",
      "situacao",
      "situacaoPedido",
    ]),
    normalizedOrder?.rawStatus,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if ([
    "dispatch",
    "despach",
    "out_for_delivery",
    "cancel",
    "concluded",
    "completed",
    "finished",
    "delivered",
  ].some((word) => eventText.includes(word))) {
    return false;
  }

  return [
    "production_ready",
    "order_ready",
    "ready_for_pickup",
    "ready for pickup",
    "waiting_to_catch",
    "waiting to catch",
    "esperando retirada",
    "prepared",
    "ready",
    "pronto",
    "pronto para retirada",
    "pedido pronto",
    "producao pronta",
    "produção pronta",
  ].some((word) => eventText.includes(word));
}

function isDispatchEvent(payload, normalizedOrder) {
  return Boolean(removalEventKind(payload, normalizedOrder));
}

async function handleWebhook(payload) {
  let payloadForOrder = payload;
  const webhookRemovalKind = removalEventKind(payload, null);

  if (payload.orderURL && !webhookRemovalKind) {
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

  const removalKind = webhookRemovalKind || removalEventKind({ ...payload, ...payloadForOrder }, normalizedOrder);

  if (removalKind) {
    if (currentIndex >= 0) {
      const removedOrder = orders.splice(currentIndex, 1)[0];
      writeOrders(orders);
      if (ENABLE_KDS) {
        removeKdsReadyOrder(removedOrder);
      }

      if (removalKind === "dispatched") {
        recordDispatchedOrder(removedOrder, payload);
      }
    }

    if (removalKind === "closed") {
      removeDispatchedOrder(normalizedOrder);
      if (ENABLE_KDS) {
        removeKdsReadyOrder(normalizedOrder);
      }
    }

    return {
      ok: true,
      action: removalKind === "dispatched" ? "removed" : "closed",
      order: normalizedOrder.number,
      eventType: payload.eventType || "",
    };
  }

  const activeOrder = { ...normalizedOrder, lastSeenOpenAt: Date.now() };

  if (isOrderAlreadyDispatched(activeOrder)) {
    if (ENABLE_KDS) {
      removeKdsReadyOrder(activeOrder);
    }
    writeOrders(orders.filter((order) => !isSameOrder(order, activeOrder)));

    return {
      ok: true,
      action: "already-dispatched",
      order: normalizedOrder.number,
    };
  }

  const previousOrder = currentIndex >= 0 ? orders[currentIndex] : null;
  const readyFromCardapio = isProductionReadyEvent({ ...payload, ...payloadForOrder }, activeOrder);
  const nextActiveOrder = {
    ...activeOrder,
    externalReadyAt: readyFromCardapio
      ? previousOrder?.externalReadyAt || Date.now()
      : previousOrder?.externalReadyAt || activeOrder.externalReadyAt || null,
  };

  if (currentIndex >= 0) {
    orders[currentIndex] = { ...orders[currentIndex], ...nextActiveOrder };
  } else {
    orders.push(nextActiveOrder);
  }

  writeOrders(orders);
  if (ENABLE_KDS) {
    reconcileKdsReadyOrder(nextActiveOrder, previousOrder);
  }

  if (readyFromCardapio) {
    const readyResult = ENABLE_KDS
      ? markKdsOrderReadyFromCardapio(nextActiveOrder)
      : { ok: true, action: "cardapio-ready-synced", order: nextActiveOrder.number };
    recordSystemEvent(
      { order: nextActiveOrder.number, orderId: nextActiveOrder.orderId, source: "cardapio-ready" },
      readyResult
    );
  }

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

  if (!ENABLE_KDS && ["/kds", "/producao", "/kds.html"].includes(requestPath)) {
    serveKdsPausedPage(response);
    return;
  }

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

function serveKdsPausedPage(response) {
  response.writeHead(200, { "Content-Type": contentTypes[".html"] });
  response.end(`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>KDS pausado</title>
    <style>
      body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1218;color:#f8fafc;font-family:Arial,sans-serif}
      main{max-width:620px;padding:32px;text-align:center}
      h1{font-size:42px;margin:0 0 12px}
      p{font-size:20px;color:#bfd0e6;line-height:1.45}
      a{display:inline-block;margin-top:18px;padding:14px 20px;border-radius:8px;background:#f8fafc;color:#08111b;font-weight:800;text-decoration:none}
    </style>
  </head>
  <body>
    <main>
      <h1>KDS pausado</h1>
      <p>Para estabilizar a operação, o sistema está rodando somente com o Painel de Expedição.</p>
      <a href="/">Abrir Painel de Expedição</a>
    </main>
  </body>
</html>`);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/login") {
    if (isPanelAuthenticated(request)) {
      response.writeHead(302, { Location: "/" });
      response.end();
      return;
    }

    serveLoginPage(response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/login") {
    await handleLogin(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    response.writeHead(200, {
      "Content-Type": contentTypes[".json"],
      "Set-Cookie": clearPanelAuthCookie(request),
    });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!requirePanelAuth(request, response, url)) {
    return;
  }

  if (
    !["/api/orders", "/api/events", "/api/dispatched-orders", "/api/clear-dispatched-orders", "/api/create-test-orders", "/api/clear-test-orders", "/api/sync-open-orders", "/api/production-summary", "/api/kds-orders", "/api/kds-ready-orders", "/api/kds-ready", "/api/kds-item-ready", "/api/kds-dispatch", "/api/drivers", "/api/health", "/api/updates"].includes(url.pathname) &&
    !["/", "/index.html", "/app.js", "/kds", "/producao", "/kds.html", "/kds.js", "/styles.css", "/logo-la-qualite.png", "/favicon.ico", "/api/webhook/cardapio-web"].includes(
      url.pathname
    )
  ) {
    recordEvent(request, { note: "Chamada recebida fora das rotas principais." }, {
      ok: true,
      action: "request-logged",
    });
  }

  if (request.method === "GET" && url.pathname === "/api/orders") {
    const sync = url.searchParams.get("sync") === "1"
      ? await syncOpenOrdersForPageLoad()
      : null;
    sendJson(response, 200, { orders: ordersWithKdsStatus(), sync });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, healthSnapshot());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/updates") {
    openEventStream(request, response);
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

  if (request.method === "POST" && url.pathname === "/api/clear-dispatched-orders") {
    const result = clearDispatchedOrders();
    recordSystemEvent({ source: "monitor", manual: true }, result);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/create-test-orders") {
    try {
      const body = await readBody(request);
      const result = createTestOrders(body);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Carga de teste invalida." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/clear-test-orders") {
    const result = clearTestOrders();
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/drivers") {
    sendJson(response, 200, { drivers: readDrivers() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/drivers") {
    try {
      const body = await readBody(request);
      const result = saveDriver(body);
      sendJson(response, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Motoboy invalido." });
    }
    return;
  }

  if (request.method === "DELETE" && url.pathname === "/api/drivers") {
    try {
      const body = await readBody(request);
      const result = removeDriver(body);
      sendJson(response, result.ok ? 200 : 404, result);
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Motoboy invalido." });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/production-summary") {
    sendJson(response, 200, buildProductionSummary());
    return;
  }

  if (!ENABLE_KDS && url.pathname.startsWith("/api/kds")) {
    sendJson(response, 503, {
      ok: false,
      action: "kds-paused",
      message: "KDS pausado. Operacao atual focada somente no Painel de Expedicao.",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/kds-orders") {
    const sync = url.searchParams.get("sync") === "1"
      ? await syncOpenOrdersForPageLoad()
      : null;
    sendJson(response, 200, {
      updatedAt: formatLocalTime(),
      sync,
      orders: buildKdsOrders(),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/kds-ready-orders") {
    sendJson(response, 200, {
      updatedAt: formatLocalTime(),
      orders: buildKdsReadyOrders(),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/kds-debug") {
    sendJson(response, 200, { orders: buildKdsDebug() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/kds-ready") {
    try {
      const body = await readBody(request);
      const result = await markKdsOrderReady(body);
      sendJson(response, result.ok ? 200 : 404, result);
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Pedido invalido." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/kds-item-ready") {
    try {
      const body = await readBody(request);
      const result = await markKdsItemReady(body);
      sendJson(response, result.ok ? 200 : 404, result);
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Produto invalido." });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/kds-dispatch") {
    try {
      const body = await readBody(request);
      const result = await dispatchKdsReadyOrder(body);
      sendJson(response, result.ok ? 200 : 404, result);
    } catch (error) {
      sendJson(response, 400, { ok: false, message: "Despacho invalido." });
    }
    return;
  }

  if (["GET", "POST"].includes(request.method) && url.pathname === "/api/sync-open-orders") {
    try {
      const result = await syncOpenOrders();
      recordSystemEvent({ source: CARDAPIO_EVENTS_URL, manual: true }, result);
      sendJson(response, 200, result);
    } catch (error) {
      const result = { ok: false, action: "sync-failed", message: error.message };
      recordSystemEvent({ source: CARDAPIO_EVENTS_URL, manual: true }, result);
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

initializeStorage().then(() => {
  compactOperationalState();

  server.listen(PORT, HOST, () => {
    console.log(`Painel rodando em http://localhost:${PORT}`);
    console.log(`Webhook local: http://localhost:${PORT}/api/webhook/cardapio-web`);
    console.log(`Armazenamento: ${storageMode}`);
    setTimeout(syncOpenOrdersSafely, 5000);
    setInterval(syncOpenOrdersSafely, SYNC_OPEN_ORDERS_INTERVAL_MS);
    setInterval(pingEventClients, 25000);
    setInterval(maintainMemoryPressure, 60 * 1000);
    setInterval(compactOperationalState, 5 * 60 * 1000);
  });
});
