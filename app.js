const DEFAULT_LATE_LIMIT_MINUTES = 30;
const savedLateLimit = Number(localStorage.getItem("lateLimitMinutes"));
let lateLimitMinutes = Number.isFinite(savedLateLimit) && savedLateLimit > 0
  ? savedLateLimit
  : DEFAULT_LATE_LIMIT_MINUTES;

let orders = [];
let dispatchedOrders = [];
let events = [];

let activeFilter = "all";

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

  if (minutes >= lateLimitMinutes) {
    return { label: "Atrasado", className: "late" };
  }

  if (minutes >= Math.max(lateLimitMinutes - 1, 0)) {
    return { label: "Atencao", className: "warning" };
  }

  return { label: "No prazo", className: "ok" };
}

function renderOrders() {
  const isSettingsOpen = activeFilter === "settings";
  const isEventsOpen = activeFilter === "events";
  const isDispatchedOpen = activeFilter === "dispatched";
  const activeOrders = [...orders].sort((a, b) => elapsedSeconds(b) - elapsedSeconds(a));
  const lateOrders = activeOrders.filter(isLate);
  const visibleOrders = activeFilter === "late" ? lateOrders : activeOrders;

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
        : '<div class="empty">Nenhum pedido na loja no momento.</div>';
    return;
  }

  orderList.innerHTML = visibleOrders
    .map((order) => {
      const status = statusFor(order);

      return `
        <article class="order-row">
          <div class="order-number">#${order.number}</div>
          <div class="order-info">
            <span class="mobile-label">Cliente</span>
            <strong>${order.customer}</strong>
          </div>
          <div class="order-info">
            <span class="mobile-label">Bairro</span>
            <strong>${order.neighborhood}</strong>
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
        <div class="order-info">
          <span class="mobile-label">Cliente</span>
          <strong>${order.customer}</strong>
        </div>
        <div class="order-info">
          <span class="mobile-label">Bairro</span>
          <strong>${order.neighborhood}</strong>
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
    const response = await fetch("/api/orders");
    const data = await response.json();
    orders = Array.isArray(data.orders) ? data.orders : [];
  } catch (error) {
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
    activeFilter = tab.dataset.filter;

    tabs.forEach((item) => item.classList.toggle("active", item === tab));
    renderOrders();
  });
});

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
loadDispatchedOrders();
loadEvents();
setInterval(loadOrders, 5000);
setInterval(loadDispatchedOrders, 5000);
setInterval(loadEvents, 5000);
setInterval(renderOrders, 1000);
