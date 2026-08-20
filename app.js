const DEFAULT_LATE_LIMIT_MINUTES = 30;
const savedLateLimit = Number(localStorage.getItem("lateLimitMinutes"));
const savedDeliveryLateLimit = Number(localStorage.getItem("deliveryLateLimitMinutes"));
const savedPickupLateLimit = Number(localStorage.getItem("pickupLateLimitMinutes"));
const initialLateLimit = Number.isFinite(savedLateLimit) && savedLateLimit > 0
  ? savedLateLimit
  : DEFAULT_LATE_LIMIT_MINUTES;
let deliveryLateLimitMinutes = Number.isFinite(savedDeliveryLateLimit) && savedDeliveryLateLimit > 0
  ? savedDeliveryLateLimit
  : initialLateLimit;
let pickupLateLimitMinutes = Number.isFinite(savedPickupLateLimit) && savedPickupLateLimit > 0
  ? savedPickupLateLimit
  : initialLateLimit;

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
const preparingLabel = document.querySelector("#preparing-label");
const preparingCount = document.querySelector("#preparing-count");
const dispatchedLabel = document.querySelector("#dispatched-label");
const dispatchedCount = document.querySelector("#dispatched-count");
const grandTotalLabel = document.querySelector("#grand-total-label");
const grandTotalCount = document.querySelector("#grand-total-count");
const eventsCount = document.querySelector("#events-count");
const eventsList = document.querySelector("#events-list");
const monitorMainStatus = document.querySelector("#monitor-main-status");
const monitorSystem = document.querySelector("#monitor-system");
const monitorStorage = document.querySelector("#monitor-storage");
const monitorScreens = document.querySelector("#monitor-screens");
const monitorMemoryCard = document.querySelector("#monitor-memory-card");
const monitorMemory = document.querySelector("#monitor-memory");
const monitorMemoryHint = document.querySelector("#monitor-memory-hint");
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
const monitorCreateTests = document.querySelector("#monitor-create-tests");
const monitorClearTests = document.querySelector("#monitor-clear-tests");
const monitorClearDispatched = document.querySelector("#monitor-clear-dispatched");
const monitorSystemCard = document.querySelector("#monitor-system-card");
const monitorStorageCard = document.querySelector("#monitor-storage-card");
const monitorActionsCard = document.querySelector("#monitor-actions-card");
const monitorWritesCard = document.querySelector("#monitor-writes-card");
const tabs = document.querySelectorAll(".tab");
const configToggle = document.querySelector("#config-toggle");
const configOptions = document.querySelector("#config-options");
const deliveryLimitInput = document.querySelector("#delivery-limit-input");
const pickupLimitInput = document.querySelector("#pickup-limit-input");
const deliveryLimitLabel = document.querySelector("#delivery-limit-label");
const pickupLimitLabel = document.querySelector("#pickup-limit-label");
const lateAlertToggle = document.querySelector("#late-alert-toggle");
const lateAlertTest = document.querySelector("#late-alert-test");
const fullscreenButton = document.querySelector("#fullscreen-button");
const footerUpdated = document.querySelector("#footer-updated");
const footerRefresh = document.querySelector("#footer-refresh");
const APP_TIME_ZONE = "America/Sao_Paulo";
const LATE_ALERT_SOUND_KEY = "lateAlertSoundEnabled";

let lateAlertSoundEnabled = localStorage.getItem(LATE_ALERT_SOUND_KEY) !== "false";
let lateAlertAudioContext = null;
let previousLateOrderKeys = null;
let previousDuplicatePhoneKeys = null;

function elapsedMinutes(order) {
  return Math.floor((Date.now() - Number(order.arrivedAt)) / 60000);
}

function elapsedSeconds(order) {
  return Math.floor((Date.now() - Number(order.arrivedAt)) / 1000);
}

function orderSortValue(order) {
  const number = Number(order.number);

  return Number.isFinite(number) ? number : Number(order.arrivedAt || 0);
}

function formatTimer(order) {
  const totalSeconds = elapsedSeconds(order);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function isPickupReady(order) {
  return isPickup(order) && (order?.externalReadyAt || order?.kdsStatus?.state === "ready");
}

function lateLimitForOrder(order) {
  return isPickup(order) ? pickupLateLimitMinutes : deliveryLateLimitMinutes;
}

function isLate(order) {
  return !isPickupReady(order) && elapsedMinutes(order) >= lateLimitForOrder(order);
}

function alertKeyForOrder(order) {
  return String(order.orderId || order.number || order.arrivedAt || "");
}

function ensureLateAlertAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    return null;
  }

  if (!lateAlertAudioContext) {
    lateAlertAudioContext = new AudioContextClass();
  }

  if (lateAlertAudioContext.state === "suspended") {
    lateAlertAudioContext.resume().catch(() => {});
  }

  return lateAlertAudioContext;
}

function playLateAlertSound() {
  if (!lateAlertSoundEnabled) {
    return;
  }

  playAlertTone([880, 988, 880]);
}

function playDuplicateAlertSound() {
  playAlertTone([660, 880, 1175, 880]);
}

function playAlertTone(notes) {
  const audioContext = ensureLateAlertAudio();

  if (!audioContext) {
    return;
  }

  const now = audioContext.currentTime;
  notes.forEach((frequency, index) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const startsAt = now + index * 0.22;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, startsAt);
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(0.24, startsAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.2);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + 0.22);
  });
}

function syncLateAlertControl() {
  if (lateAlertToggle) {
    lateAlertToggle.checked = lateAlertSoundEnabled;
  }
}

function handleLateAlerts(lateOrders) {
  const currentLateKeys = new Set(lateOrders.map(alertKeyForOrder).filter(Boolean));

  if (!previousLateOrderKeys) {
    previousLateOrderKeys = currentLateKeys;
    return;
  }

  const hasNewLateOrder = [...currentLateKeys].some((key) => !previousLateOrderKeys.has(key));
  previousLateOrderKeys = currentLateKeys;

  if (hasNewLateOrder) {
    playLateAlertSound();
  }
}

function statusFor(order) {
  if (isPickupReady(order)) {
    return { label: "Esperando retirada", className: "ready" };
  }

  const minutes = elapsedMinutes(order);
  const lateLimitMinutes = lateLimitForOrder(order);
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

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function isMeaningfulPhone(value) {
  return normalizePhone(value).length >= 8;
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

function duplicateSignals(sourceOrders) {
  return {
    phones: duplicateKeyCounts(sourceOrders, (order) =>
      isMeaningfulPhone(order.phone) ? normalizePhone(order.phone) : ""
    ),
  };
}

function duplicatePhoneCount(order, signals) {
  const phone = normalizePhone(order.phone);

  return isMeaningfulPhone(order.phone) ? signals.phones.get(phone) || 0 : 0;
}

function isPossibleDuplicate(order, signals) {
  return duplicatePhoneCount(order, signals) > 1;
}

function duplicateGroupLabel(order, signals) {
  const count = duplicatePhoneCount(order, signals);

  return count > 1 ? `Mesmo telefone: ${count} pedidos` : "";
}

function duplicatePhoneKeys(sourceOrders, signals) {
  return sourceOrders
    .filter((order) => isPossibleDuplicate(order, signals))
    .map((order) => normalizePhone(order.phone))
    .filter(Boolean);
}

function groupDuplicateOrders(sourceOrders, signals) {
  return [...sourceOrders].sort((left, right) => {
    const leftPhone = normalizePhone(left.phone);
    const rightPhone = normalizePhone(right.phone);
    const leftDuplicate = isPossibleDuplicate(left, signals);
    const rightDuplicate = isPossibleDuplicate(right, signals);

    if (leftDuplicate !== rightDuplicate) {
      return leftDuplicate ? -1 : 1;
    }

    if (leftDuplicate && rightDuplicate && leftPhone !== rightPhone) {
      return leftPhone.localeCompare(rightPhone);
    }

    return orderSortValue(left) - orderSortValue(right);
  });
}

function handleDuplicateAlerts(sourceOrders, signals) {
  const currentDuplicatePhones = new Set(duplicatePhoneKeys(sourceOrders, signals));

  if (!previousDuplicatePhoneKeys) {
    previousDuplicatePhoneKeys = currentDuplicatePhones;
    return;
  }

  const hasNewDuplicatePhone = [...currentDuplicatePhones].some((phone) => !previousDuplicatePhoneKeys.has(phone));
  previousDuplicatePhoneKeys = currentDuplicatePhones;

  if (hasNewDuplicatePhone) {
    playDuplicateAlertSound();
  }
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

function metricContextForFilter() {
  if (activeFilter === "delivery") {
    return {
      activeFilter: isDelivery,
      dispatchedFilter: isDelivery,
      preparingLabel: "Entregas em preparo",
      dispatchedLabel: "Entregas despachadas",
      totalLabel: "Total de entregas",
    };
  }

  if (activeFilter === "pickup") {
    return {
      activeFilter: (order) => isPickup(order) && !isPickupReady(order),
      dispatchedFilter: isPickup,
      readyActiveFilter: isPickupReady,
      preparingLabel: "Retiradas em preparo",
      dispatchedLabel: "Retiradas prontas",
      totalLabel: "Total de retiradas",
    };
  }

  return {
    activeFilter: (order) => !isPickupReady(order),
    dispatchedFilter: () => true,
    readyActiveFilter: isPickupReady,
    preparingLabel: "Pedidos em preparo",
    dispatchedLabel: "Pedidos despachados",
    totalLabel: "Total de pedidos",
  };
}

function updateMetricsBar(activeOrders) {
  const context = metricContextForFilter();
  const preparingTotal = activeOrders.filter(context.activeFilter).length;
  const readyActiveTotal = context.readyActiveFilter
    ? activeOrders.filter(context.readyActiveFilter).length
    : 0;
  const dispatchedTotal = dispatchedOrders.filter(context.dispatchedFilter).length + readyActiveTotal;

  if (preparingLabel) {
    preparingLabel.textContent = context.preparingLabel;
  }
  if (dispatchedLabel) {
    dispatchedLabel.textContent = context.dispatchedLabel;
  }
  if (grandTotalLabel) {
    grandTotalLabel.textContent = context.totalLabel;
  }
  if (preparingCount) {
    preparingCount.textContent = String(preparingTotal);
  }
  if (dispatchedCount) {
    dispatchedCount.textContent = String(dispatchedTotal);
  }
  if (grandTotalCount) {
    grandTotalCount.textContent = String(preparingTotal + dispatchedTotal);
  }
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
  const activeOrders = [...orders].sort((a, b) => orderSortValue(a) - orderSortValue(b));
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
  updateMetricsBar(activeOrders);
  handleLateAlerts(lateOrders);
  if (footerUpdated) {
    footerUpdated.textContent = new Date().toLocaleTimeString("pt-BR", {
      timeZone: APP_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (deliveryLimitInput) {
    deliveryLimitInput.value = String(deliveryLateLimitMinutes);
  }
  if (pickupLimitInput) {
    pickupLimitInput.value = String(pickupLateLimitMinutes);
  }
  if (deliveryLimitLabel) {
    deliveryLimitLabel.textContent = String(deliveryLateLimitMinutes);
  }
  if (pickupLimitLabel) {
    pickupLimitLabel.textContent = String(pickupLateLimitMinutes);
  }
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

  handleDuplicateAlerts(activeOrders, duplicateInfo);
  orderList.innerHTML = groupDuplicateOrders(visibleOrders, duplicateInfo)
    .map((order) => {
      const status = statusFor(order);
      const isDuplicate = isPossibleDuplicate(order, duplicateInfo);
      const duplicateLabel = duplicateGroupLabel(order, duplicateInfo);

      return `
        <article class="order-row priority-${status.className}${isDuplicate ? " has-duplicate-customer" : ""}">
          <div class="row-index">#</div>
          <div class="order-number">#${order.number}</div>
          <div class="service-badge ${isPickup(order) ? "pickup" : "delivery"}">${orderTypeLabel(order)}</div>
          <div class="order-info">
            <span class="mobile-label">Cliente</span>
            <strong>${order.customer}</strong>
            ${isDuplicate ? `<span class="duplicate-alert">Possível duplicado</span><span class="duplicate-group">${duplicateLabel}</span>` : ""}
          </div>
          <div class="order-info">
            <span class="mobile-label">Bairro</span>
            <strong>${displayNeighborhood(order)}</strong>
          </div>
          <div class="order-info">
            <span class="mobile-label">Cidade</span>
            <strong>${displayCity(order)}</strong>
          </div>
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
        <div class="row-index">#</div>
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

function memoryState(memoryMb) {
  if (!Number.isFinite(memoryMb)) {
    return { state: "warning", label: "--", hint: "Aguardando leitura" };
  }

  if (memoryMb >= 450) {
    return { state: "danger", label: `${memoryMb} MB`, hint: "Risco de reiniciar" };
  }

  if (memoryMb >= 350) {
    return { state: "warning", label: `${memoryMb} MB`, hint: "Observar" };
  }

  return { state: "ok", label: `${memoryMb} MB`, hint: "Tranquilo" };
}

function renderMonitor() {
  const lastEvent = events[0];
  const isStorageOk = health?.storage === "postgres" && health?.storageReady && !health?.storageError;
  const pendingActions = Number(health?.pendingOrderActions || 0);
  const pendingWrites = Number(health?.pendingStorageWrites || 0);
  const memory = memoryState(Number(health?.memory?.rssMb));
  const isSystemOk = Boolean(health?.ok) && isStorageOk && pendingActions === 0 && pendingWrites === 0;

  monitorMainStatus.textContent = monitorMessage || (isSystemOk ? "Sistema saudável" : "Atenção necessária");
  monitorSystem.textContent = health?.ok ? "Online" : "Sem resposta";
  monitorStorage.textContent = isStorageOk ? "PostgreSQL conectado" : "Verificar banco";
  monitorScreens.textContent = String(health?.connectedScreens ?? 0);
  monitorMemory.textContent = memory.label;
  monitorMemoryHint.textContent = memory.hint;
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
  setMonitorCardState(monitorMemoryCard, memory.state);
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

async function createTestOrdersNow() {
  if (!monitorCreateTests) {
    return;
  }

  monitorCreateTests.disabled = true;
  monitorMessage = "Criando pedidos teste...";
  renderMonitor();

  try {
    const response = await fetch("/api/create-test-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 50 }),
    });
    const result = await response.json();
    monitorMessage = result.ok
      ? `${result.count || 0} pedido(s) teste criado(s)`
      : result.message || "Falha ao criar testes";
  } catch (error) {
    monitorMessage = "Falha ao chamar carga de teste";
  }

  await Promise.all([loadOrders(), loadEvents(), loadDispatchedOrders(), loadHealth()]);
  monitorCreateTests.disabled = false;

  setTimeout(() => {
    monitorMessage = "";
    renderMonitor();
  }, 4000);
}

async function clearTestOrdersNow() {
  if (!monitorClearTests) {
    return;
  }

  const confirmed = window.confirm("Limpar somente os pedidos teste? Pedidos reais nao serao apagados.");

  if (!confirmed) {
    return;
  }

  monitorClearTests.disabled = true;
  monitorMessage = "Limpando pedidos teste...";
  renderMonitor();

  try {
    const response = await fetch("/api/clear-test-orders", { method: "POST" });
    const result = await response.json();
    monitorMessage = result.ok
      ? `${result.count || 0} registro(s) teste removido(s)`
      : result.message || "Falha ao limpar testes";
  } catch (error) {
    monitorMessage = "Falha ao chamar limpeza de testes";
  }

  await Promise.all([loadOrders(), loadEvents(), loadDispatchedOrders(), loadHealth()]);
  monitorClearTests.disabled = false;

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
    if (activeFilter === "events") {
      loadEvents();
    }
    if (activeFilter === "monitor") {
      loadHealth();
    }
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

    if (activeFilter === "events") {
      loadEvents();
    }

    if (activeFilter === "monitor") {
      loadEvents();
      loadHealth();
    }

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

if (monitorCreateTests) {
  monitorCreateTests.addEventListener("click", createTestOrdersNow);
}

if (monitorClearTests) {
  monitorClearTests.addEventListener("click", clearTestOrdersNow);
}

if (monitorClearDispatched) {
  monitorClearDispatched.addEventListener("click", clearDispatchedNow);
}

if (footerRefresh) {
  footerRefresh.addEventListener("click", () => {
    loadOrders();
    loadDispatchedOrders();
    if (activeFilter === "events") {
      loadEvents();
    }
    if (activeFilter === "monitor") {
      loadHealth();
    }
  });
}

if (lateAlertToggle) {
  lateAlertToggle.addEventListener("change", () => {
    lateAlertSoundEnabled = lateAlertToggle.checked;
    localStorage.setItem(LATE_ALERT_SOUND_KEY, String(lateAlertSoundEnabled));
    ensureLateAlertAudio();
  });
}

if (lateAlertTest) {
  lateAlertTest.addEventListener("click", () => {
    lateAlertSoundEnabled = true;
    localStorage.setItem(LATE_ALERT_SOUND_KEY, "true");
    syncLateAlertControl();
    playLateAlertSound();
  });
}

["pointerdown", "keydown"].forEach((eventName) => {
  window.addEventListener(eventName, ensureLateAlertAudio, { once: true });
});

if (deliveryLimitInput) {
  deliveryLimitInput.addEventListener("input", () => {
    const nextLimit = Number(deliveryLimitInput.value);

    if (!Number.isFinite(nextLimit) || nextLimit < 1) {
      return;
    }

    deliveryLateLimitMinutes = nextLimit;
    localStorage.setItem("deliveryLateLimitMinutes", String(deliveryLateLimitMinutes));
    renderOrders();
  });
}

if (pickupLimitInput) {
  pickupLimitInput.addEventListener("input", () => {
    const nextLimit = Number(pickupLimitInput.value);

    if (!Number.isFinite(nextLimit) || nextLimit < 1) {
      return;
    }

    pickupLateLimitMinutes = nextLimit;
    localStorage.setItem("pickupLateLimitMinutes", String(pickupLateLimitMinutes));
    renderOrders();
  });
}

loadOrders();
updateFullscreenButton();
syncLateAlertControl();
loadDispatchedOrders();
connectLiveUpdates();
setInterval(loadOrders, 15000);
setInterval(loadDispatchedOrders, 15000);
setInterval(() => {
  if (activeFilter === "events") {
    loadEvents();
  }
  if (activeFilter === "monitor") {
    loadHealth();
  }
}, 15000);
setInterval(renderOrders, 1000);
