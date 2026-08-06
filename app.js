const DEFAULT_LATE_LIMIT_MINUTES = 30;
const savedLateLimit = Number(localStorage.getItem("lateLimitMinutes"));
let lateLimitMinutes = Number.isFinite(savedLateLimit) && savedLateLimit > 0
  ? savedLateLimit
  : DEFAULT_LATE_LIMIT_MINUTES;

let orders = [];
let events = [];

let activeFilter = "all";

const orderList = document.querySelector("#order-list");
const ordersPanel = document.querySelector("#orders-panel");
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
  return elapsedMinutes(order) > lateLimitMinutes;
}

function statusFor(order) {
  const minutes = elapsedMinutes(order);

  if (minutes > lateLimitMinutes) {
    return { label: "Atrasado", className: "late" };
  }

  if (minutes >= Math.max(lateLimitMinutes - 5, 0)) {
    return { label: "Atencao", className: "warning" };
  }

  return { label: "No prazo", className: "ok" };
}

function renderOrders() {
  const isSettingsOpen = activeFilter === "settings";
  const isEventsOpen = activeFilter === "events";
  const activeOrders = [...orders].sort((a, b) => elapsedSeconds(b) - elapsedSeconds(a));
  const lateOrders = activeOrders.filter(isLate);
  const visibleOrders = activeFilter === "late" ? lateOrders : activeOrders;

  totalCount.textContent = String(activeOrders.length);
  lateCount.textContent = String(lateOrders.length);
  limitInput.value = String(lateLimitMinutes);
  limitLabel.textContent = String(lateLimitMinutes);
  ordersPanel.hidden = isSettingsOpen || isEventsOpen;
  settingsPanel.hidden = !isSettingsOpen;
  eventsPanel.hidden = !isEventsOpen;

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
loadEvents();
setInterval(loadOrders, 5000);
setInterval(loadEvents, 5000);
setInterval(renderOrders, 1000);
