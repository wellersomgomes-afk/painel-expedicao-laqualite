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
let drivers = [];
let health = null;
let monitorMessage = "";
let dispatchMessage = "";
let dispatchMessageState = "";
let dispatchInFlight = false;
const selectedDispatchOrderIds = new Set();

const SAVED_PANEL_VIEW_KEY = "expeditionActiveView";
const validPanelViews = new Set([
  "all",
  "delivery",
  "pickup",
  "late",
  "dispatch",
  "dispatched",
  "settings",
  "monitor",
  "events",
]);
const savedPanelView = localStorage.getItem(SAVED_PANEL_VIEW_KEY) || "all";
let activeFilter = validPanelViews.has(savedPanelView) ? savedPanelView : "all";
let shouldSyncOnNextOrdersLoad = true;
let liveRefreshTimer = null;

const orderList = document.querySelector("#order-list");
const ordersPanel = document.querySelector("#orders-panel");
const dispatchedPanel = document.querySelector("#dispatched-panel");
const dispatchedList = document.querySelector("#dispatched-list");
const settingsPanel = document.querySelector("#settings-panel");
const eventsPanel = document.querySelector("#events-panel");
const monitorPanel = document.querySelector("#monitor-panel");
const dispatchPanel = document.querySelector("#dispatch-panel");
const dispatchOrderList = document.querySelector("#dispatch-order-list");
const dispatchDriverSelect = document.querySelector("#dispatch-driver-select");
const dispatchSelectedCount = document.querySelector("#dispatch-selected-count");
const dispatchSelectAll = document.querySelector("#dispatch-select-all");
const dispatchConfirm = document.querySelector("#dispatch-confirm");
const dispatchFeedback = document.querySelector("#dispatch-feedback");
const preparationFilters = document.querySelector("#preparation-filters");
const orderMetricsBar = document.querySelector("#order-metrics-bar");
const ordersSummary = document.querySelector("#orders-summary");
const totalCount = document.querySelector("#total-count");
const lateCount = document.querySelector("#late-count");
const preparingLabel = document.querySelector("#preparing-label");
const preparingCount = document.querySelector("#preparing-count");
const readyLabel = document.querySelector("#ready-label");
const readyCount = document.querySelector("#ready-count");
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
const browserNotificationEnable = document.querySelector("#browser-notification-enable");
const browserNotificationStatus = document.querySelector("#browser-notification-status");
const fullscreenButton = document.querySelector("#fullscreen-button");
const footerUpdated = document.querySelector("#footer-updated");
const footerRefresh = document.querySelector("#footer-refresh");
const APP_TIME_ZONE = "America/Sao_Paulo";
const LATE_ALERT_SOUND_KEY = "lateAlertSoundEnabled";
const NOTIFICATION_PROMPT_DISMISSED_KEY = "browserNotificationPromptDismissed";

let lateAlertSoundEnabled = localStorage.getItem(LATE_ALERT_SOUND_KEY) !== "false";
let lateAlertAudioContext = null;
let previousLateOrderKeys = null;
const acknowledgedDuplicateGroupKeys = new Set();
const acknowledgedCriticalLateKeys = new Set();
let duplicatePopupOpen = false;
let criticalLatePopupOpen = false;

function isAlertModalOpen() {
  return duplicatePopupOpen || criticalLatePopupOpen || Boolean(document.querySelector(".duplicate-modal-overlay"));
}

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

function dispatchOrderId(order) {
  return String(order.orderId || order.number || "");
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

function isOrderReady(order) {
  return Boolean(order?.externalReadyAt || order?.kdsStatus?.state === "ready");
}

function lateLimitForOrder(order) {
  return isPickup(order) ? pickupLateLimitMinutes : deliveryLateLimitMinutes;
}

function isLate(order) {
  return !isOrderReady(order) && elapsedMinutes(order) >= lateLimitForOrder(order);
}

function isDoubleLate(order) {
  return !isOrderReady(order) && elapsedMinutes(order) >= lateLimitForOrder(order) * 2;
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

function browserNotificationPermission() {
  return "Notification" in window ? Notification.permission : "unsupported";
}

function syncBrowserNotificationControl() {
  if (!browserNotificationStatus || !browserNotificationEnable) {
    return;
  }

  const permission = browserNotificationPermission();
  const labels = {
    granted: "Ativas para atrasos e possíveis duplicidades.",
    denied: "Bloqueadas nas configurações do navegador.",
    default: "Ainda não ativadas neste navegador.",
    unsupported: "Este navegador não oferece notificações.",
  };

  browserNotificationStatus.textContent = labels[permission] || labels.default;
  browserNotificationEnable.disabled = permission === "granted" || permission === "unsupported";
  browserNotificationEnable.textContent = permission === "granted" ? "Notificações ativas" : "Ativar notificações";
}

function showBrowserNotification(title, body, tag) {
  if (browserNotificationPermission() !== "granted") {
    return;
  }

  const notification = new Notification(title, {
    body,
    icon: "/logo-la-qualite.png",
    tag,
  });

  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

async function requestBrowserNotifications() {
  if (!("Notification" in window)) {
    syncBrowserNotificationControl();
    return false;
  }

  const permission = await Notification.requestPermission();
  syncBrowserNotificationControl();

  if (permission === "granted") {
    localStorage.removeItem(NOTIFICATION_PROMPT_DISMISSED_KEY);
    showBrowserNotification(
      "Alertas ativados",
      "O Painel de Expedição avisará sobre atrasos e possíveis pedidos duplicados.",
      "laqualite-notifications-enabled"
    );
    return true;
  }

  localStorage.setItem(NOTIFICATION_PROMPT_DISMISSED_KEY, "true");
  return false;
}

function showBrowserNotificationActivationPopup() {
  if (
    browserNotificationPermission() !== "default" ||
    localStorage.getItem(NOTIFICATION_PROMPT_DISMISSED_KEY) === "true" ||
    document.querySelector(".notification-activation-overlay")
  ) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "duplicate-modal-overlay notification-activation-overlay";
  overlay.innerHTML = `
    <section class="duplicate-modal notification-activation-modal" role="dialog" aria-modal="true" aria-label="Ativar alertas do navegador">
      <strong>Ativar alertas do navegador?</strong>
      <p>Receba avisos quando surgir um pedido atrasado ou uma possível duplicidade. Ao clicar no aviso, o painel volta para frente.</p>
      <div class="notification-activation-actions">
        <button class="notification-later" type="button">Agora não</button>
        <button class="notification-enable" type="button">Ativar alertas</button>
      </div>
    </section>
  `;

  overlay.querySelector(".notification-later").addEventListener("click", () => {
    localStorage.setItem(NOTIFICATION_PROMPT_DISMISSED_KEY, "true");
    overlay.remove();
  });
  overlay.querySelector(".notification-enable").addEventListener("click", async () => {
    await requestBrowserNotifications();
    overlay.remove();
  });

  document.body.appendChild(overlay);
  overlay.querySelector(".notification-enable").focus();
}

function handleLateAlerts(lateOrders) {
  const currentLateKeys = new Set(lateOrders.map(alertKeyForOrder).filter(Boolean));

  if (!previousLateOrderKeys) {
    previousLateOrderKeys = currentLateKeys;
    return;
  }

  const newLateOrders = lateOrders.filter((order) => !previousLateOrderKeys.has(alertKeyForOrder(order)));
  previousLateOrderKeys = currentLateKeys;

  if (newLateOrders.length > 0) {
    playLateAlertSound();
    showBrowserNotification(
      newLateOrders.length === 1 ? "Pedido atrasado" : `${newLateOrders.length} pedidos atrasados`,
      newLateOrders.map((order) => `#${order.number} - ${order.customer || "Cliente"}`).join(" | "),
      `laqualite-late-${newLateOrders.map(alertKeyForOrder).join("-")}`
    );
  }
}

function doubleLateAlertKey(order) {
  return `${alertKeyForOrder(order)}:${lateLimitForOrder(order)}`;
}

function showDoubleLatePopup(lateOrders) {
  if (isAlertModalOpen() || lateOrders.length === 0) {
    return;
  }

  criticalLatePopupOpen = true;
  const overlay = document.createElement("div");
  overlay.className = "duplicate-modal-overlay";
  overlay.innerHTML = `
    <section class="duplicate-modal late-modal" role="alertdialog" aria-modal="true" aria-label="Pedido muito atrasado">
      <strong>Pedido muito atrasado</strong>
      <p>Pedido passou do dobro do tempo configurado:</p>
      <ul>
        ${lateOrders.map((order) => `
          <li>#${order.number} - ${order.customer || "Cliente"} - ${elapsedMinutes(order)} min</li>
        `).join("")}
      </ul>
      <button type="button">OK</button>
    </section>
  `;

  overlay.querySelector("button").addEventListener("click", () => {
    lateOrders.forEach((order) => acknowledgedCriticalLateKeys.add(doubleLateAlertKey(order)));
    criticalLatePopupOpen = false;
    overlay.remove();
  });

  document.body.appendChild(overlay);
  overlay.querySelector("button").focus();
}

function handleDoubleLateAlerts(activeOrders) {
  const doubleLateOrders = activeOrders.filter(isDoubleLate);
  const currentDoubleLateKeys = new Set(doubleLateOrders.map(doubleLateAlertKey));
  const newDoubleLateOrders = doubleLateOrders.filter((order) => !acknowledgedCriticalLateKeys.has(doubleLateAlertKey(order)));

  [...acknowledgedCriticalLateKeys].forEach((key) => {
    if (!currentDoubleLateKeys.has(key)) {
      acknowledgedCriticalLateKeys.delete(key);
    }
  });

  if (newDoubleLateOrders.length > 0 && !isAlertModalOpen()) {
    playLateAlertSound();
    showDoubleLatePopup(newDoubleLateOrders);
  }
}

function statusFor(order) {
  if (isOrderReady(order)) {
    return { label: isPickup(order) ? "Esperando retirada" : "Pronto", className: "ready" };
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
    customersAndAddresses: duplicateKeyCounts(sourceOrders, duplicateCustomerAddressKey),
  };
}

function normalizeDuplicateText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function duplicateCustomerAddressKey(order) {
  if (isMeaningfulPhone(order.phone)) return "";
  const customer = normalizeDuplicateText(order.customer);
  const address = normalizeDuplicateText(order.address);
  return customer.length >= 4 && customer !== "cliente" && address.length >= 6
    ? `${customer}|${address}`
    : "";
}

function duplicatePhoneCount(order, signals) {
  const phone = normalizePhone(order.phone);

  return isMeaningfulPhone(order.phone) ? signals.phones.get(phone) || 0 : 0;
}

function isPossibleDuplicate(order, signals) {
  const fallbackKey = duplicateCustomerAddressKey(order);
  return duplicatePhoneCount(order, signals) > 1 ||
    (fallbackKey && (signals.customersAndAddresses.get(fallbackKey) || 0) > 1);
}

function duplicateGroupLabel(order, signals) {
  const count = duplicatePhoneCount(order, signals);

  if (count > 1) return `Mesmo telefone: ${count} pedidos`;
  const fallbackCount = signals.customersAndAddresses.get(duplicateCustomerAddressKey(order)) || 0;
  return fallbackCount > 1 ? `Mesmo cliente e endereço: ${fallbackCount} pedidos` : "";
}

function duplicateAlertKey(order) {
  const phone = normalizePhone(order.phone);
  return isMeaningfulPhone(phone) ? `phone:${phone}` : `customer-address:${duplicateCustomerAddressKey(order)}`;
}

function duplicateAlertKeys(sourceOrders, signals) {
  return [...new Set(sourceOrders.filter((order) => isPossibleDuplicate(order, signals)).map(duplicateAlertKey).filter(Boolean))];
}

function formatDuplicatePhone(phone) {
  if (phone.length === 11) {
    return `(${phone.slice(0, 2)}) ${phone.slice(2, 7)}-${phone.slice(7)}`;
  }

  if (phone.length === 10) {
    return `(${phone.slice(0, 2)}) ${phone.slice(2, 6)}-${phone.slice(6)}`;
  }

  return phone;
}

function duplicateOrderLabel(order) {
  return `#${order.number || "--"} - ${order.customer || "Cliente"}`;
}

function duplicatePopupMessage(keys, sourceOrders) {
  return keys.flatMap((key) =>
    sourceOrders
      .filter((order) => duplicateAlertKey(order) === key)
      .sort((left, right) => orderSortValue(left) - orderSortValue(right))
      .map(duplicateOrderLabel)
  );
}

function duplicateGroupKey(key, signals) {
  const count = key.startsWith("phone:")
    ? signals.phones.get(key.slice(6)) || 0
    : signals.customersAndAddresses.get(key.slice("customer-address:".length)) || 0;
  return `${key}:${count}`;
}

function showDuplicatePopup(keys, signals, sourceOrders) {
  if (isAlertModalOpen() || keys.length === 0) {
    return;
  }

  duplicatePopupOpen = true;
  const overlay = document.createElement("div");
  overlay.className = "duplicate-modal-overlay";
  overlay.innerHTML = `
    <section class="duplicate-modal" role="alertdialog" aria-modal="true" aria-label="Possivel pedido duplicado">
      <strong>Possivel pedido duplicado</strong>
      <p>Pedidos com o mesmo telefone ou cliente/endereço:</p>
      <ul>
        ${duplicatePopupMessage(keys, sourceOrders).map((line) => `<li>${line}</li>`).join("")}
      </ul>
      <button type="button">OK</button>
    </section>
  `;

  overlay.querySelector("button").addEventListener("click", () => {
    keys.forEach((key) => acknowledgedDuplicateGroupKeys.add(duplicateGroupKey(key, signals)));
    duplicatePopupOpen = false;
    overlay.remove();
  });

  document.body.appendChild(overlay);
  overlay.querySelector("button").focus();
}

function groupDuplicateOrders(sourceOrders, signals) {
  return [...sourceOrders].sort((left, right) => {
    const leftKey = duplicateAlertKey(left);
    const rightKey = duplicateAlertKey(right);
    const leftDuplicate = isPossibleDuplicate(left, signals);
    const rightDuplicate = isPossibleDuplicate(right, signals);

    if (leftDuplicate !== rightDuplicate) {
      return leftDuplicate ? -1 : 1;
    }

    if (leftDuplicate && rightDuplicate && leftKey !== rightKey) {
      return leftKey.localeCompare(rightKey);
    }

    return orderSortValue(left) - orderSortValue(right);
  });
}

function handleDuplicateAlerts(sourceOrders, signals) {
  const currentDuplicateKeys = new Set(duplicateAlertKeys(sourceOrders, signals));
  const currentGroupKeys = new Set([...currentDuplicateKeys].map((key) => duplicateGroupKey(key, signals)));
  const newDuplicateKeys = [...currentDuplicateKeys]
    .filter((key) => !acknowledgedDuplicateGroupKeys.has(duplicateGroupKey(key, signals)));

  [...acknowledgedDuplicateGroupKeys].forEach((key) => {
    if (!currentGroupKeys.has(key)) {
      acknowledgedDuplicateGroupKeys.delete(key);
    }
  });

  if (newDuplicateKeys.length > 0 && !isAlertModalOpen()) {
    playDuplicateAlertSound();
    showBrowserNotification(
      "Possível pedido duplicado",
      duplicatePopupMessage(newDuplicateKeys, sourceOrders).join(" | "),
      `panel-duplicate-${newDuplicateKeys.join("-")}`
    );
    showDuplicatePopup(newDuplicateKeys, signals, sourceOrders);
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
      activeFilter: (order) => isDelivery(order) && !isOrderReady(order),
      dispatchedFilter: isDelivery,
      readyActiveFilter: (order) => isDelivery(order) && isOrderReady(order),
      preparingLabel: "Entregas em preparo",
      readyLabel: "Entregas prontas",
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
      readyLabel: "Retiradas prontas",
      dispatchedLabel: "Retiradas finalizadas",
      totalLabel: "Total de retiradas",
    };
  }

  return {
    activeFilter: (order) => !isOrderReady(order),
    dispatchedFilter: () => true,
    readyActiveFilter: isOrderReady,
    preparingLabel: "Pedidos em preparo",
    readyLabel: "Pedidos prontos",
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
  const dispatchedTotal = dispatchedOrders.filter(context.dispatchedFilter).length;

  if (preparingLabel) {
    preparingLabel.textContent = context.preparingLabel;
  }
  if (dispatchedLabel) {
    dispatchedLabel.textContent = context.dispatchedLabel;
  }
  if (readyLabel) {
    readyLabel.textContent = context.readyLabel;
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
  if (readyCount) {
    readyCount.textContent = String(readyActiveTotal);
  }
  if (grandTotalCount) {
    grandTotalCount.textContent = String(preparingTotal + readyActiveTotal + dispatchedTotal);
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
  const isDispatchOpen = activeFilter === "dispatch";
  const isDispatchedOpen = activeFilter === "dispatched";
  const isPreparationOpen = ["all", "preparing", "ready", "delivery", "pickup", "late"].includes(activeFilter);
  const activeOrders = [...orders].sort((a, b) => orderSortValue(a) - orderSortValue(b));
  const duplicateInfo = duplicateSignals(activeOrders);
  const deliveryOrders = activeOrders.filter(isDelivery);
  const pickupOrders = activeOrders.filter(isPickup);
  const lateOrders = activeOrders.filter(isLate);
  const preparingOrders = activeOrders.filter((order) => !isOrderReady(order));
  const readyOrders = activeOrders.filter(isOrderReady);
  const visibleOrders =
    activeFilter === "preparing"
      ? preparingOrders
      : activeFilter === "ready"
        ? readyOrders
        : activeFilter === "late"
      ? lateOrders
      : activeFilter === "pickup"
        ? pickupOrders
        : activeFilter === "delivery"
          ? deliveryOrders
          : activeOrders;

  if (totalCount) {
    totalCount.textContent = String(activeOrders.length);
  }
  lateCount.textContent = String(lateOrders.length);
  updateMetricsBar(activeOrders);
  handleLateAlerts(lateOrders);
  handleDoubleLateAlerts(activeOrders);
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
  ordersPanel.hidden = isSettingsOpen || isEventsOpen || isMonitorOpen || isDispatchOpen || isDispatchedOpen;
  dispatchedPanel.hidden = !isDispatchedOpen;
  if (dispatchPanel) {
    dispatchPanel.hidden = !isDispatchOpen;
  }
  settingsPanel.hidden = !isSettingsOpen;
  eventsPanel.hidden = !isEventsOpen;
  monitorPanel.hidden = !isMonitorOpen;
  if (preparationFilters) {
    preparationFilters.hidden = !isPreparationOpen;
  }
  if (orderMetricsBar) {
    orderMetricsBar.hidden = !isPreparationOpen;
  }
  if (ordersSummary) {
    ordersSummary.hidden = !isPreparationOpen;
  }

  if (isDispatchedOpen) {
    renderDispatchedOrders();
    return;
  }

  if (isDispatchOpen) {
    renderDispatchPanel();
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
        : activeFilter === "ready"
          ? '<div class="empty">Nenhum pedido pronto informado pelo Cardápio Web.</div>'
          : activeFilter === "preparing"
            ? '<div class="empty">Nenhum pedido em preparo no momento.</div>'
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

function renderDispatchDriverOptions() {
  if (!dispatchDriverSelect) {
    return;
  }

  const currentValue = dispatchDriverSelect.value || localStorage.getItem("dispatchSelectedDriverId") || "";
  dispatchDriverSelect.innerHTML = [
    '<option value="">Selecione o motoboy</option>',
    ...drivers.map((driver) => `<option value="${driver.id}">${driver.name}</option>`),
  ].join("");

  if (drivers.some((driver) => String(driver.id) === currentValue)) {
    dispatchDriverSelect.value = currentValue;
  }
}

function renderDispatchPanel() {
  if (!dispatchPanel || !dispatchOrderList) {
    return;
  }

  const deliveryOrders = [...orders]
    .filter(isDelivery)
    .sort((left, right) => orderSortValue(left) - orderSortValue(right));
  const availableIds = new Set(deliveryOrders.map(dispatchOrderId));

  for (const orderId of selectedDispatchOrderIds) {
    if (!availableIds.has(orderId)) {
      selectedDispatchOrderIds.delete(orderId);
    }
  }

  if (dispatchSelectedCount) {
    dispatchSelectedCount.textContent = String(selectedDispatchOrderIds.size);
  }
  if (dispatchConfirm) {
    dispatchConfirm.disabled = dispatchInFlight || selectedDispatchOrderIds.size === 0 || !dispatchDriverSelect?.value;
    dispatchConfirm.textContent = dispatchInFlight ? "Despachando..." : "Despachar selecionados";
  }
  if (dispatchSelectAll) {
    const allSelected = deliveryOrders.length > 0 && deliveryOrders.every((order) => selectedDispatchOrderIds.has(dispatchOrderId(order)));
    dispatchSelectAll.disabled = dispatchInFlight || deliveryOrders.length === 0;
    dispatchSelectAll.textContent = allSelected ? "Limpar seleção" : "Selecionar todos";
  }
  if (dispatchFeedback) {
    dispatchFeedback.hidden = !dispatchMessage;
    dispatchFeedback.textContent = dispatchMessage;
    dispatchFeedback.className = `dispatch-feedback${dispatchMessageState ? ` ${dispatchMessageState}` : ""}`;
  }

  if (deliveryOrders.length === 0) {
    dispatchOrderList.innerHTML = '<div class="empty">Nenhuma entrega disponível para despacho.</div>';
    return;
  }

  dispatchOrderList.innerHTML = deliveryOrders.map((order) => {
    const orderId = dispatchOrderId(order);
    const selected = selectedDispatchOrderIds.has(orderId);
    const status = statusFor(order);

    return `
      <button class="dispatch-order-row priority-${status.className}${selected ? " is-selected" : ""}" type="button" data-order-id="${orderId}" aria-pressed="${selected}">
        <span class="dispatch-checkbox" aria-hidden="true">${selected ? "✓" : ""}</span>
        <strong class="dispatch-order-number">#${order.number}</strong>
        <span>${order.customer}</span>
        <span>${displayNeighborhood(order)}</span>
        <span>${displayCity(order)}</span>
        <strong class="dispatch-order-time">${formatTimer(order)}</strong>
        <span class="status ${status.className}">${status.label}</span>
      </button>
    `;
  }).join("");
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

async function loadDrivers() {
  try {
    const response = await fetch("/api/drivers");
    const data = await response.json();
    drivers = Array.isArray(data.drivers) ? data.drivers : [];
  } catch (error) {
    drivers = [];
  }

  renderDispatchDriverOptions();
  renderDispatchPanel();
}

async function dispatchSelectedOrders() {
  if (dispatchInFlight || !dispatchDriverSelect?.value || selectedDispatchOrderIds.size === 0) {
    return;
  }

  const driver = drivers.find((item) => String(item.id) === dispatchDriverSelect.value);
  const selectedOrders = orders
    .filter(isDelivery)
    .filter((order) => selectedDispatchOrderIds.has(dispatchOrderId(order)))
    .map((order) => ({ number: order.number, orderId: order.orderId }));

  if (!driver || selectedOrders.length === 0) {
    dispatchMessage = "Selecione um motoboy e pelo menos um pedido.";
    dispatchMessageState = "danger";
    renderDispatchPanel();
    return;
  }

  const confirmed = window.confirm(`Despachar ${selectedOrders.length} pedido(s) com ${driver.name}?`);
  if (!confirmed) {
    return;
  }

  dispatchInFlight = true;
  dispatchMessage = "Enviando despachos ao Cardápio Web...";
  dispatchMessageState = "";
  renderDispatchPanel();

  try {
    const response = await fetch("/api/dispatch-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driverId: driver.id,
        driverName: driver.name,
        orders: selectedOrders,
      }),
    });
    const result = await response.json();

    for (const item of result.results || []) {
      if (item.ok) {
        selectedDispatchOrderIds.delete(String(item.orderId || item.order || ""));
      }
    }

    if (result.failed) {
      const failedOrders = (result.results || []).filter((item) => !item.ok).map((item) => `#${item.order}`).join(", ");
      dispatchMessage = `${result.succeeded || 0} despachado(s). ${result.failed} falha(s): ${failedOrders}. Consulte Eventos.`;
      dispatchMessageState = "danger";
    } else if (result.ok) {
      dispatchMessage = `${result.succeeded || selectedOrders.length} pedido(s) despachado(s) com ${driver.name}.`;
      dispatchMessageState = "ok";
      selectedDispatchOrderIds.clear();
    } else {
      dispatchMessage = result.message || "Não foi possível concluir o despacho. Consulte Eventos.";
      dispatchMessageState = "danger";
    }
  } catch (error) {
    dispatchMessage = "Falha de comunicação ao despachar. Consulte Eventos e tente novamente.";
    dispatchMessageState = "danger";
  }

  dispatchInFlight = false;
  await Promise.all([loadOrders(), loadDispatchedOrders(), loadEvents(), loadHealth()]);
  renderDispatchPanel();
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

  const confirmed = window.confirm("Limpar a lista de despachados? Os pedidos ativos não serão apagados.");

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

function updateTabStates() {
  const preparationFilterNames = ["all", "preparing", "ready", "delivery", "pickup", "late"];
  const isPreparationOpen = preparationFilterNames.includes(activeFilter);

  tabs.forEach((item) => {
    const isPreparationMainTab = item.id === "preparation-tab";
    const isPreparationSubFilter = item.classList.contains("prep-filter");
    const isActive = isPreparationMainTab
      ? isPreparationOpen
      : isPreparationSubFilter
        ? item.dataset.filter === activeFilter
        : item.dataset.filter === activeFilter;

    item.classList.toggle("active", isActive);
  });

  configToggle?.classList.toggle("active", isConfigFilter(activeFilter));
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
    localStorage.setItem(SAVED_PANEL_VIEW_KEY, activeFilter);
    setConfigMenuOpen(false);

    updateTabStates();

    if (activeFilter === "events") {
      loadEvents();
    }

    if (activeFilter === "monitor") {
      loadEvents();
      loadHealth();
    }

    if (activeFilter === "dispatch") {
      loadDrivers();
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

if (dispatchDriverSelect) {
  dispatchDriverSelect.addEventListener("change", () => {
    localStorage.setItem("dispatchSelectedDriverId", dispatchDriverSelect.value);
    renderDispatchPanel();
  });
}

if (dispatchSelectAll) {
  dispatchSelectAll.addEventListener("click", () => {
    const deliveryOrders = orders.filter(isDelivery);
    const allSelected = deliveryOrders.length > 0 && deliveryOrders.every((order) => selectedDispatchOrderIds.has(dispatchOrderId(order)));
    selectedDispatchOrderIds.clear();
    if (!allSelected) {
      deliveryOrders.forEach((order) => selectedDispatchOrderIds.add(dispatchOrderId(order)));
    }
    dispatchMessage = "";
    dispatchMessageState = "";
    renderDispatchPanel();
  });
}

if (dispatchConfirm) {
  dispatchConfirm.addEventListener("click", dispatchSelectedOrders);
}

if (dispatchOrderList) {
  dispatchOrderList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-order-id]");
    if (!row || dispatchInFlight) {
      return;
    }

    const orderId = String(row.dataset.orderId || "");
    if (selectedDispatchOrderIds.has(orderId)) {
      selectedDispatchOrderIds.delete(orderId);
    } else {
      selectedDispatchOrderIds.add(orderId);
    }
    dispatchMessage = "";
    dispatchMessageState = "";
    renderDispatchPanel();
  });
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

if (browserNotificationEnable) {
  browserNotificationEnable.addEventListener("click", requestBrowserNotifications);
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

updateTabStates();
syncBrowserNotificationControl();
showBrowserNotificationActivationPopup();
loadOrders();
updateFullscreenButton();
syncLateAlertControl();
loadDispatchedOrders();
loadDrivers();
if (activeFilter === "events") {
  loadEvents();
}
if (activeFilter === "monitor") {
  loadEvents();
  loadHealth();
}
connectLiveUpdates();
setInterval(loadOrders, 5000);
setInterval(loadDispatchedOrders, 10000);
setInterval(() => {
  if (activeFilter === "events") {
    loadEvents();
  }
  if (activeFilter === "monitor") {
    loadHealth();
  }
}, 15000);
setInterval(renderOrders, 1000);
