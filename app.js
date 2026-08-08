const DEFAULT_LATE_LIMIT_MINUTES = 30;
const savedLateLimit = Number(localStorage.getItem("lateLimitMinutes"));
let lateLimitMinutes = Number.isFinite(savedLateLimit) && savedLateLimit > 0
  ? savedLateLimit
  : DEFAULT_LATE_LIMIT_MINUTES;

let orders = [];
let dispatchedOrders = [];
let events = [];

let activeFilter = "all";
let shouldSyncOnNextOrdersLoad = true;

const orderList = document.querySelector("#order-list");
const ordersPanel = document.querySelector("#orders-panel");
const dispatchedPanel = document.querySelector("#dispatched-panel");
const dispatchedList = document.querySelector("#dispatched-list");
const settingsPanel = document.querySelector("#settings-panel");
const eventsPanel = document.querySelector("#events-panel");
const totalCount = document.querySelector("#total-count");
const lateCount = document.querySelector("#late-count");
const eventsCount = document.querySelector("#events-count");
const eventsList = document.querySelector("#events-list");
const tabs = document.querySelectorAll(".tab");
const limitInput = document.querySelector("#limit-input");
const limitLabel = document.querySelector("#limit-label");
const fullscreenButton = document.querySelector("#fullscreen-button");
const APP_TIME_ZONE = "America/Sao_Paulo";

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
  const isDispatchedOpen = activeFilter === "dispatched";
  const activeOrders = [...orders].sort((a, b) => elapsedSeconds(b) - elapsedSeconds(a));
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
  ordersPanel.hidden = isSettingsOpen || isEventsOpen || isDispatchedOpen;
  dispatchedPanel.hidden = !isDispatchedOpen;
  settingsPanel.hidden = !isSettingsOpen;
  eventsPanel.hidden = !isEventsOpen;

  if (isDispatchedOpen) {
    renderDispatchedOrders();
    return;
  }

  if (isEventsOpen) {
    renderEvents();
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

      return `
        <article class="order-row priority-${status.className}">
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
        <div class="status ok">Despachado ${formatDispatchedTime(order)}</div>
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

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.id === "fullscreen-button") {
      toggleFullscreen();
      return;
    }

    activeFilter = tab.dataset.filter;

    tabs.forEach((item) => item.classList.toggle("active", item === tab));
    renderOrders();
  });
});

if (fullscreenButton) {
  document.addEventListener("fullscreenchange", updateFullscreenButton);
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
setInterval(loadOrders, 5000);
setInterval(loadDispatchedOrders, 5000);
setInterval(loadEvents, 5000);
setInterval(renderOrders, 1000);
