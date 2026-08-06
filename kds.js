let board = {
  updatedAt: "--:--",
  productionOrders: [],
  readyOrders: [],
};

const orderCount = document.querySelector("#kds-order-count");
const countLabel = document.querySelector("#kds-count-label");
const updatedAt = document.querySelector("#kds-updated-at");
const grid = document.querySelector("#kds-grid");
const sizeButtons = document.querySelectorAll(".kds-size-button");
const viewTabs = document.querySelectorAll(".kds-view-tab");
let cardSize = localStorage.getItem("kdsCardSize") || "normal";
let activeView = localStorage.getItem("kdsActiveView") || "production";

function elapsedSeconds(order) {
  return Math.max(Math.floor((Date.now() - Number(order.arrivedAt || Date.now())) / 1000), 0);
}

function formatTimer(order) {
  const totalSeconds = elapsedSeconds(order);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function formatQuantity(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    maximumFractionDigits: 2,
  });
}

function formatReadyTime(order) {
  if (!order.readyAt) {
    return "";
  }

  return new Date(Number(order.readyAt)).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isBorderText(value) {
  return normalizeText(value).includes("borda");
}

function isPizzaItem(item) {
  const text = normalizeText(`${item.category || ""} ${item.name || ""}`);

  return text.includes("pizza") || text.includes("pizzas");
}

function filterOrderForPizza(order) {
  const items = (order.items || []).filter(isPizzaItem);

  if (items.length === 0) {
    return null;
  }

  return { ...order, items };
}

function renderComplement(complement) {
  const highlightClass = isBorderText(complement.name) ? " kds-complement-border" : "";

  return `
    <li class="kds-complement${highlightClass}">
      <span>${complement.name}</span>
      ${Number(complement.quantity || 1) > 1 ? `<strong>${formatQuantity(complement.quantity)}x</strong>` : ""}
    </li>
  `;
}

function renderItemNote(note) {
  return `
    <div class="kds-item-note">
      <span>Obs:</span>
      <strong>${note}</strong>
    </div>
  `;
}

function renderItem(item) {
  const complements = item.complements || [];
  const hasBorderHighlight = isBorderText(item.name) || complements.some((complement) => isBorderText(complement.name));

  return `
    <article class="kds-order-item${hasBorderHighlight ? " has-border" : ""}">
      <div class="kds-product-line">
        <strong>${formatQuantity(item.quantity)}x</strong>
        <span>${item.name}</span>
      </div>
      ${complements.length > 0 ? `
        <ul class="kds-complements">
          ${complements.map(renderComplement).join("")}
        </ul>
      ` : ""}
      ${item.notes ? renderItemNote(item.notes) : ""}
    </article>
  `;
}

function renderOrder(order) {
  const service = order.fulfillmentType === "pickup" ? "Retirada" : order.neighborhood || "Entrega";
  const isReadyView = activeView === "ready";

  return `
    <article class="kds-order-card${isReadyView ? " is-ready" : ""}" data-number="${order.number}" data-order-id="${order.orderId || ""}">
      <header class="kds-order-head">
        <div>
          <strong>#${order.number}</strong>
          <span>${order.customer || "Cliente"}</span>
        </div>
        <div class="kds-order-time">${isReadyView ? `Pronto ${formatReadyTime(order)}` : formatTimer(order)}</div>
      </header>
      <div class="kds-service">${service}</div>
      ${order.notes ? `
        <div class="kds-order-notes">
          <span>Observacoes</span>
          <strong>${order.notes}</strong>
        </div>
      ` : ""}
      <div class="kds-order-items">
        ${order.items.map(renderItem).join("")}
      </div>
      ${isReadyView ? `
        <div class="kds-ready-stamp">Pedido pronto</div>
      ` : `
        <button class="kds-ready-button" type="button" data-number="${order.number}" data-order-id="${order.orderId || ""}">
          Pronto
        </button>
      `}
    </article>
  `;
}

function isPickupOrder(order) {
  return order.fulfillmentType === "pickup";
}

function renderOrderSection(title, orders) {
  if (orders.length === 0) {
    return "";
  }

  return `
    <section class="kds-section">
      <header class="kds-section-head">
        <span>${title}</span>
        <strong>${orders.length}</strong>
      </header>
      <div class="kds-section-grid">
        ${orders.map(renderOrder).join("")}
      </div>
    </section>
  `;
}

function applyCardSize() {
  document.body.classList.remove("kds-size-compact", "kds-size-normal", "kds-size-large");
  document.body.classList.add(`kds-size-${cardSize}`);

  sizeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.size === cardSize);
  });
}

function applyActiveView() {
  viewTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === activeView);
  });
}

function currentOrders() {
  const sourceOrders = activeView === "ready" ? board.readyOrders : board.productionOrders;

  return sourceOrders.map(filterOrderForPizza).filter(Boolean);
}

function renderKds() {
  applyCardSize();
  applyActiveView();
  const orders = currentOrders();

  countLabel.textContent = activeView === "ready" ? "Pedidos prontos" : "Pedidos em preparo";
  orderCount.textContent = String(orders.length);
  updatedAt.textContent = board.updatedAt || "--:--";

  if (orders.length === 0) {
    grid.innerHTML = activeView === "ready"
      ? '<div class="empty kds-empty">Nenhuma pizza pronta no momento.</div>'
      : '<div class="empty kds-empty">Nenhuma pizza em producao no momento.</div>';
    return;
  }

  const deliveryOrders = orders.filter((order) => !isPickupOrder(order));
  const pickupOrders = orders.filter(isPickupOrder);

  grid.innerHTML = [
    renderOrderSection("Entregas", deliveryOrders),
    renderOrderSection("Retiradas", pickupOrders),
  ].join("");
}

async function loadKdsOrders() {
  try {
    const [productionResponse, readyResponse] = await Promise.all([
      fetch("/api/kds-orders"),
      fetch("/api/kds-ready-orders"),
    ]);
    const productionData = await productionResponse.json();
    const readyData = await readyResponse.json();

    board = {
      updatedAt: productionData.updatedAt || readyData.updatedAt || "--:--",
      productionOrders: Array.isArray(productionData.orders) ? productionData.orders : [],
      readyOrders: Array.isArray(readyData.orders) ? readyData.orders : [],
    };
  } catch (error) {
    board = {
      updatedAt: "--:--",
      productionOrders: [],
      readyOrders: [],
    };
  }

  renderKds();
}

async function markOrderReady(button) {
  button.disabled = true;
  button.textContent = "Salvando...";

  try {
    const response = await fetch("/api/kds-ready", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: button.dataset.number,
        orderId: button.dataset.orderId,
      }),
    });

    if (!response.ok) {
      throw new Error("Falha ao marcar pronto");
    }

    await loadKdsOrders();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Pronto";
  }
}

sizeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    cardSize = button.dataset.size;
    localStorage.setItem("kdsCardSize", cardSize);
    applyCardSize();
  });
});

viewTabs.forEach((button) => {
  button.addEventListener("click", () => {
    activeView = button.dataset.view;
    localStorage.setItem("kdsActiveView", activeView);
    renderKds();
  });
});

grid.addEventListener("click", (event) => {
  const button = event.target.closest(".kds-ready-button");

  if (button) {
    markOrderReady(button);
  }
});

applyCardSize();
applyActiveView();
loadKdsOrders();
setInterval(loadKdsOrders, 5000);
setInterval(renderKds, 1000);
