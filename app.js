const DEFAULT_LATE_LIMIT_MINUTES = 30;
const savedLateLimit = Number(localStorage.getItem("lateLimitMinutes"));
let lateLimitMinutes = Number.isFinite(savedLateLimit) && savedLateLimit > 0
  ? savedLateLimit
  : DEFAULT_LATE_LIMIT_MINUTES;

let orders = [];
let dispatchedOrders = [];
let events = [];
let health = null;
let monitorMessage = "";

let activeFilter = "all";
let shouldSyncOnNextOrdersLoad = true;
let liveRefreshTimer = null;

const orderList = document.querySelector("#order-list");
const ordersPanel = document.querySelector("#orders-panel");
const dispatchedPanel = document.querySelector("#dispatched-panel");
const dispatchedList = document.querySelector("#dispatched-list");
const settingsPanel = document.querySelector("#settings-panel");
const eventsPanel = document.querySelector("#events-panel");
const monitorPanel = document.querySelector("#monitor-panel");
const totalCount = document.querySelector("#total-count");
const lateCount = document.querySelector("#late-count");
const eventsCount = document.querySelector("#events-count");
const eventsList = document.querySelector("#events-list");
const monitorMainStatus = document.querySelector("#monitor-main-status");
const monitorSystem = document.querySelector("#monitor-system");
const monitorStorage = document.querySelector("#monitor-storage");
const monitorScreens = document.querySelector("#monitor-screens");
const monitorMemory = document.querySelector("#monitor-memory");
const monitorOrders = document.querySelector("#monitor-orders");
const monitorReady = document.querySelector("#monitor-ready");
const monitorDispatched = document.querySelector("#monitor-dispatched");
const monitorPendingActions = document.querySelector("#monitor-pending-actions");
const monitorPendingWrites = document.querySelector("#monitor-pending-writes");
const monitorUpdated = document.querySelector("#monitor-updated");
const monitorError = document.querySelector("#monitor-error");
const monitorLastEvent = document.querySelector("#monitor-last-event");
const monitorRefresh = document.querySelector("#monitor-refresh");
const monitorSync = document.querySelector("#monitor-sync");
const monitorClearDispatched = document.querySelector("#monitor-clear-dispatched");
const monitorSystemCard = document.querySelector("#monitor-system-card");
const monitorStorageCard = document.querySelector("#monitor-storage-card");
const monitorActionsCard = document.querySelector("#monitor-actions-card");
const monitorWritesCard = document.querySelector("#monitor-writes-card");
const tabs = document.querySelectorAll(".tab");
const configToggle = document.querySelector("#config-toggle");
const configOptions = document.querySelector("#config-options");
const limitInput = document.querySelector("#limit-input");
const limitLabel = document.querySelector("#limit-label");
const fullscreenButton = document.querySelector("#fullscreen-button");
const APP_TIME_ZONE = "America/Sao_Paulo";
const DUPLICATE_TIME_WINDOW_MINUTES = 10;

function elapsedMinutes(order) {
  return Math.floor((Date.now() - Number(order.arrivedAt)) / 60000);
}

function elapsedSeconds(order) {
  return Math.floor((Date.now() - Number(order.arrivedAt)) / 1000);
}

function formatTimer(order) {
  const totalSeconds = elapsedSeconds(order);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function isLate(order) {
  return elapsedMinutes(order) >= lateLimitMinutes;
}

function statusFor(order) {
  const minutes = elapsedMinutes(order);
  const attentionLimit = Math.min(20, Math.max(lateLimitMinutes - 10, 0));

  if (minutes >= lateLimitMinutes + 15) {
    return { label: "Muito atrasado", className: "critical" };
  }

  if (minutes >= lateLimitMinutes) {
    return { label: "Atrasado", className: "late" };
  }

  if (minutes >= attentionLimit) {
    return { label: "Atenção", className: "warning" };
  }

  return { label: "No prazo", className: "ok" };
}

function isPickup(order) {
  return order.fulfillmentType === "pickup";
}

function isDelivery(order) {
  return !isPickup(order);
}

function displayNeighborhood(order) {
  return isPickup(order) || order.neighborhood === "Bairro nao informado"
    ? ""
    : order.neighborhood;
}

function displayCity(order) {
  return isPickup(order) ? "" : order.city || "Cidade nao informada";
}

function normalizeCustomerName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeAddress(value) {
  return normalizeCustomerName(value);
}

function isMeaningfulCustomerName(value) {
  const name = normalizeCustomerName(value);
  const genericNames = new Set(["cliente", "nao informado", "consumidor", "sem nome"]);

  return name.length >= 5 && !genericNames.has(name);
}

function isMeaningfulPhone(value) {
  return normalizePhone(value).length >= 8;
}

function isMeaningfulAddress(value) {
  const address = normalizeAddress(value);

  return address.length >= 8 && !address.includes("nao informado");
}

function duplicateKeyCounts(sourceOrders, keyFactory) {
  return sourceOrders.reduce((counts, order) => {
    const key = keyFactory(order);

    if (key) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, new Map());
}

function orderDuplicateId(order) {
  return String(order.orderId || order.number || "");
}

function duplicateNearbyOrders(sourceOrders) {
  const windowMs = DUPLICATE_TIME_WINDOW_MINUTES * 60000;
  const comparableOrders = sourceOrders
    .map((order) => ({
      id: orderDuplicateId(order),
      arrivedAt: Number(order.arrivedAt),
      identities: [
        isMeaningfulPhone(order.phone) ? normalizePhone(order.phone) : "",
        isMeaningfulAddress(order.address) ? normalizeAddress(order.address) : "",
        isMeaningfulCustomerName(order.customer) ? normalizeCustomerName(order.customer) : "",
      ].filter(Boolean),
    }))
    .filter((order) => order.id && Number.isFinite(order.arrivedAt) && order.identities.length > 0);
  const duplicates = new Set();

  comparableOrders.forEach((order, index) => {
    comparableOrders.slice(index + 1).forEach((otherOrder) => {
      const isNear = Math.abs(order.arrivedAt - otherOrder.arrivedAt) <= windowMs;
      const isSameClient = order.identities.some((identity) => otherOrder.identities.includes(identity));

      if (isNear && isSameClient) {
        duplicates.add(order.id);
        duplicates.add(otherOrder.id);
      }
    });
  });

  return duplicates;
}

function duplicateSignals(sourceOrders) {
  return {
    names: duplicateKeyCounts(sourceOrders, (order) =>
      isMeaningfulCustomerName(order.customer) ? normalizeCustomerName(order.customer) : ""
    ),
    phones: duplicateKeyCounts(sourceOrders, (order) =>
      isMeaningfulPhone(order.phone) ? normalizePhone(order.phone) : ""
    ),
    addresses: duplicateKeyCounts(sourceOrders, (order) =>
      isMeaningfulAddress(order.address) ? normalizeAddress(order.address) : ""
    ),
    nearby: duplicateNearbyOrders(sourceOrders),
  };
}

function isPossibleDuplicate(order, signals) {
  const phone = normalizePhone(order.phone);
  const address = normalizeAddress(order.address);
  const id = orderDuplicateId(order);

  return (
    (isMeaningfulPhone(order.phone) && (signals.phones.get(phone) || 0) > 1) ||
    (isMeaningfulAddress(order.address) && (signals.addresses.get(address) || 0) > 1) ||
    (id && signals.nearby.has(id))
  );
}

function orderTypeLabel(order) {
  return isPickup(order) ? "Retirada" : "Entrega";
}

function kdsStatusFor(order) {
  const status = order.kdsStatus || {};
  const state = status.state || "preparing";
  const label = status.label || "Em preparo";
  const readyCount = Number(status.readyCount || 0);
  const totalCount = Number(status.totalCount || 0);
  const progress = totalCount > 0 && state === "partial" ? ` ${readyCount}/${totalCount}` : "";

  return { label: `${label}${progress}`, state };
}

function updateFullscreenButton() {
  if (!fullscreenButton) {
    return;
  }

  fullscreenButton.textContent = document.fullscreenElement ? "Sair" : "Tela cheia";
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    await document.documentElement.requestFullscreen();
  } catch (error) {
    updateFullscreenButton();
  }
}

function renderOrders() {
  const isSettingsOpen = activeFilter === "settings";
  const isEventsOpen = activeFilter === "events";
  const isMonitorOpen = activeFilter === "monitor";
  const isDispatchedOpen = activeFilter === "dispatched";
  const activeOrders = [...orders].sort((a, b) => elapsedSeconds(b) - elapsedSeconds(a));
  const duplicateInfo = duplicateSignals(activeOrders);
  const deliveryOrders = activeOrders.filter(isDelivery);
  const pickupOrders = activeOrders.filter(isPickup);
  const lateOrders = activeOrders.filter(isLate);
  const visibleOrders =
    activeFilter === "late"
      ? lateOrders
      : activeFilter === "pickup"
        ? pickupOrders
        : activeFilter === "delivery"
          ? deliveryOrders
          : activeOrders;

  totalCount.textContent = String(activeOrders.length);
  lateCount.textContent = String(lateOrders.length);
  limitInput.value = String(lateLimitMinutes);
  limitLabel.textContent = String(lateLimitMinutes);
  ordersPanel.hidden = isSettingsOpen || isEventsOpen || isMonitorOpen || isDispatchedOpen;
  dispatchedPanel.hidden = !isDispatchedOpen;
  settingsPanel.hidden = !isSettingsOpen;
  eventsPanel.hidden = !isEventsOpen;
  monitorPanel.hidden = !isMonitorOpen;

  if (isDispatchedOpen) {
    renderDispatchedOrders();
    return;
  }

  if (isEventsOpen) {
    renderEvents();
    return;
  }

  if (isMonitorOpen) {
    renderMonitor();
    return;
  }

  if (isSettingsOpen) {
    return;
  }

  if (visibleOrders.length === 0) {
    orderList.innerHTML =
      activeFilter === "late"
        ? '<div class="empty">Nenhum pedido atrasado no momento.</div>'
        : activeFilter === "pickup"
          ? '<div class="empty">Nenhum pedido de retirada no momento.</div>'
          : activeFilter === "delivery"
            ? '<div class="empty">Nenhuma entrega na loja no momento.</div>'
            : '<div class="empty">Nenhum pedido na loja no momento.</div>';
    return;
  }

  orderList.innerHTML = visibleOrders
    .map((order) => {
      const status = statusFor(order);
      const kdsStatus = kdsStatusFor(order);
      const isDuplicate = isPossibleDuplicate(order, duplicateInfo);

      return `
        <article class="order-row priority-${status.className}${isDuplicate ? " has-duplicate-customer" : ""}">
          <div class="order-number">#${order.number}</div>
          <div class="service-badge ${isPickup(order) ? "pickup" : "delivery"}">${orderTypeLabel(order)}</div>
          <div class="order-info">
            <span class="mobile-label">Cliente</span>
            <strong>${order.customer}</strong>
            ${isDuplicate ? '<span class="duplicate-alert">Possível duplicado</span>' : ""}
          </div>
          <div class="order-info">
            <span class="mobile-label">Bairro</span>
            <strong>${displayNeighborhood(order)}</strong>
          </div>
          <div class="order-info">
            <span class="mobile-label">Cidade</span>
            <strong>${displayCity(order)}</strong>
          </div>
          <div class="order-kds-status ${kdsStatus.state}">${kdsStatus.label}</div>
          <div class="timer">${formatTimer(order)}</div>
          <div class="status ${status.className}">${status.label}</div>
        </article>
      `;
    })
    .join("");
}

function formatDispatchedTime(order) {
  return new Date(Number(order.dispatchedAt)).toLocaleTimeString("pt-BR", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dispatchedStatusLabel(order) {
  return `${isPickup(order) ? "Pronto retirada" : "Despachado"} ${formatDispatchedTime(order)}`;
}

function renderDispatchedOrders() {
  if (dispatchedOrders.length === 0) {
    dispatchedList.innerHTML = '<div class="empty">Nenhum pedido despachado ainda.</div>';
    return;
  }

  dispatchedList.innerHTML = dispatchedOrders
    .map((order) => `
      <article class="order-row dispatched-row">
        <div class="order-number">#${order.number}</div>
        <div class="service-badge ${isPickup(order) ? "pickup" : "delivery"}">${orderTypeLabel(order)}</div>
        <div class="order-info">
          <span class="mobile-label">Cliente</span>
          <strong>${order.customer}</strong>
        </div>
        <div class="order-info">
          <span class="mobile-label">Bairro</span>
          <strong>${displayNeighborhood(order)}</strong>
        </div>
        <div class="order-info">
          <span class="mobile-label">Cidade</span>
          <strong>${displayCity(order)}</strong>
        </div>
        <div class="order-info">
          <span class="mobile-label">Motoboy</span>
          <strong>${order.driverName || ""}</strong>
        </div>
        <div class="status ok">${dispatchedStatusLabel(order)}</div>
      </article>
    `)
    .join("");
}

function renderEvents() {
  eventsCount.textContent = String(events.length);

  if (events.length === 0) {
    eventsList.innerHTML = '<div class="empty">Nenhum evento recebido ainda.</div>';
    return;
  }

  eventsList.innerHTML = events
    .map((event) => `
      <article class="event-row">
        <strong>${event.receivedAt}</strong>
        <span>${event.method} ${event.path}</span>
        <pre>${JSON.stringify(event.result, null, 2)}</pre>
        <pre>${JSON.stringify(event.body, null, 2)}</pre>
      </article>
    `)
    .join("");
}

function setMonitorCardState(card, state) {
  if (!card) {
    return;
  }

  card.classList.toggle("ok", state === "ok");
  card.classList.toggle("warning", state === "warning");
  card.classList.toggle("danger", state === "danger");
}

function renderMonitor() {
  const lastEvent = events[0];
  const isStorageOk = health?.storage === "postgres" && health?.storageReady && !health?.storageError;
  const pendingActions = Number(health?.pendingOrderActions || 0);
  const pendingWrites = Number(health?.pendingStorageWrites || 0);
  const isSystemOk = Boolean(health?.ok) && isStorageOk && pendingActions === 0 && pendingWrites === 0;

  monitorMainStatus.textContent = monitorMessage || (isSystemOk ? "Sistema saudável" : "Atenção necessária");
  monitorSystem.textContent = health?.ok ? "Online" : "Sem resposta";
  monitorStorage.textContent = isStorageOk ? "PostgreSQL conectado" : "Verificar banco";
  monitorScreens.textContent = String(health?.connectedScreens ?? 0);
  monitorMemory.textContent = health?.memory ? `${health.memory.rssMb} MB` : "--";
  monitorOrders.textContent = String(health?.orders ?? orders.length);
  monitorReady.textContent = String(health?.readyOrders ?? 0);
  monitorDispatched.textContent = String(health?.dispatchedOrders ?? dispatchedOrders.length);
  monitorPendingActions.textContent = String(pendingActions);
  monitorPendingWrites.textContent = String(pendingWrites);
  monitorUpdated.textContent = health?.updatedAt || "--";
  monitorError.textContent = health?.storageError || "Nenhum erro";
  monitorLastEvent.textContent = lastEvent
    ? `${lastEvent.receivedAt} - ${lastEvent.result?.action || lastEvent.result?.message || lastEvent.path}`
    : "Nenhum evento recente";

  setMonitorCardState(monitorSystemCard, health?.ok ? "ok" : "danger");
  setMonitorCardState(monitorStorageCard, isStorageOk ? "ok" : "danger");
  setMonitorCardState(monitorActionsCard, pendingActions === 0 ? "ok" : "warning");
  setMonitorCardState(monitorWritesCard, pendingWrites === 0 ? "ok" : "warning");
}

async function loadOrders() {
  try {
    const response = await fetch(shouldSyncOnNextOrdersLoad ? "/api/orders?sync=1" : "/api/orders");
    shouldSyncOnNextOrdersLoad = false;
    const data = await response.json();
    orders = Array.isArray(data.orders) ? data.orders : [];
  } catch (error) {
    shouldSyncOnNextOrdersLoad = false;
    orders = [];
  }

  renderOrders();
}

async function loadEvents() {
  try {
    const response = await fetch("/api/events");
    const data = await response.json();
    events = Array.isArray(data.events) ? data.events : [];
  } catch (error) {
    events = [];
  }

  renderOrders();
}

async function loadDispatchedOrders() {
  try {
    const response = await fetch("/api/dispatched-orders");
    const data = await response.json();
    dispatchedOrders = Array.isArray(data.orders) ? data.orders : [];
  } catch (error) {
    dispatchedOrders = [];
  }

  renderOrders();
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    health = await response.json();
  } catch (error) {
    health = {
      ok: false,
      storage: "--",
      storageReady: false,
      storageError: "Painel sem resposta no monitoramento.",
    };
  }

  renderOrders();
}

async function syncNow() {
  if (!monitorSync) {
    return;
  }

  monitorSync.disabled = true;
  monitorMessage = "Sincronizando pedidos...";
  renderMonitor();

  try {
    const response = await fetch("/api/sync-open-orders", { method: "POST" });
    const result = await response.json();
    monitorMessage = result.ok ? "Sincronização concluída" : result.message || "Falha na sincronização";
  } catch (error) {
    monitorMessage = "Falha ao chamar sincronização";
  }

  await Promise.all([loadOrders(), loadEvents(), loadDispatchedOrders(), loadHealth()]);
  monitorSync.disabled = false;

  setTimeout(() => {
    monitorMessage = "";
    renderMonitor();
  }, 4000);
}

async function clearDispatchedNow() {
  if (!monitorClearDispatched) {
    return;
  }

  const confirmed = window.confirm("Limpar a lista de despachados? Pedidos ativos e KDS nao serao apagados.");

  if (!confirmed) {
    return;
  }

  monitorClearDispatched.disabled = true;
  monitorMessage = "Limpando despachados...";
  renderMonitor();

  try {
    const response = await fetch("/api/clear-dispatched-orders", { method: "POST" });
    const result = await response.json();
    monitorMessage = result.ok
      ? `${result.count || 0} despachado(s) removido(s)`
      : result.message || "Falha ao limpar despachados";
  } catch (error) {
    monitorMessage = "Falha ao chamar limpeza";
  }

  await Promise.all([loadDispatchedOrders(), loadEvents(), loadHealth()]);
  monitorClearDispatched.disabled = false;

  setTimeout(() => {
    monitorMessage = "";
    renderMonitor();
  }, 4000);
}

function scheduleLiveRefresh() {
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(() => {
    loadOrders();
    loadDispatchedOrders();
    loadEvents();
    loadHealth();
  }, 150);
}

function connectLiveUpdates() {
  if (!window.EventSource) {
    return;
  }

  const source = new EventSource("/api/updates");
  source.addEventListener("update", scheduleLiveRefresh);
}

function isConfigFilter(filter) {
  return ["settings", "monitor", "events"].includes(filter);
}

function setConfigMenuOpen(isOpen) {
  if (!configToggle || !configOptions) {
    return;
  }

  configOptions.hidden = !isOpen;
  configToggle.setAttribute("aria-expanded", String(isOpen));
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.id === "fullscreen-button") {
      toggleFullscreen();
      return;
    }

    if (tab.id === "config-toggle") {
      setConfigMenuOpen(configOptions?.hidden);
      return;
    }

    activeFilter = tab.dataset.filter;
    setConfigMenuOpen(false);

    tabs.forEach((item) => item.classList.toggle("active", item === tab));
    configToggle?.classList.toggle("active", isConfigFilter(activeFilter));
    renderOrders();
  });
});

if (fullscreenButton) {
  document.addEventListener("fullscreenchange", updateFullscreenButton);
}

if (monitorRefresh) {
  monitorRefresh.addEventListener("click", () => {
    loadOrders();
    loadDispatchedOrders();
    loadEvents();
    loadHealth();
  });
}

if (monitorSync) {
  monitorSync.addEventListener("click", syncNow);
}

if (monitorClearDispatched) {
  monitorClearDispatched.addEventListener("click", clearDispatchedNow);
}

limitInput.addEventListener("input", () => {
  const nextLimit = Number(limitInput.value);

  if (!Number.isFinite(nextLimit) || nextLimit < 1) {
    return;
  }

  lateLimitMinutes = nextLimit;
  localStorage.setItem("lateLimitMinutes", String(lateLimitMinutes));
  renderOrders();
});

loadOrders();
updateFullscreenButton();
loadDispatchedOrders();
loadEvents();
loadHealth();
connectLiveUpdates();
setInterval(loadOrders, 5000);
setInterval(loadDispatchedOrders, 5000);
setInterval(loadEvents, 5000);
setInterval(loadHealth, 5000);
setInterval(renderOrders, 1000);
