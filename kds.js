let summary = {
  updatedAt: "--:--",
  orders: [],
};

const orderCount = document.querySelector("#kds-order-count");
const updatedAt = document.querySelector("#kds-updated-at");
const grid = document.querySelector("#kds-grid");
const sizeButtons = document.querySelectorAll(".kds-size-button");
let cardSize = localStorage.getItem("kdsCardSize") || "normal";

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

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isBorderText(value) {
  return normalizeText(value).includes("borda");
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

  return `
    <article class="kds-order-card" data-number="${order.number}" data-order-id="${order.orderId || ""}">
      <header class="kds-order-head">
        <div>
          <strong>#${order.number}</strong>
          <span>${order.customer || "Cliente"}</span>
        </div>
        <div class="kds-order-time">${formatTimer(order)}</div>
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
      <button class="kds-ready-button" type="button" data-number="${order.number}" data-order-id="${order.orderId || ""}">
        Pronto
      </button>
    </article>
  `;
}

function applyCardSize() {
  document.body.classList.remove("kds-size-compact", "kds-size-normal", "kds-size-large");
  document.body.classList.add(`kds-size-${cardSize}`);

  sizeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.size === cardSize);
  });
}

function renderKds() {
  applyCardSize();
  orderCount.textContent = String(summary.orders?.length || 0);
  updatedAt.textContent = summary.updatedAt || "--:--";

  if (!summary.orders || summary.orders.length === 0) {
    grid.innerHTML = '<div class="empty kds-empty">Nenhum pedido em producao no momento.</div>';
    return;
  }

  grid.innerHTML = summary.orders.map(renderOrder).join("");
}

async function loadKdsOrders() {
  try {
    const response = await fetch("/api/kds-orders");
    summary = await response.json();
  } catch (error) {
    summary = {
      updatedAt: "--:--",
      orders: [],
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

    summary.orders = summary.orders.filter((order) =>
      String(order.number) !== String(button.dataset.number) &&
      String(order.orderId || "") !== String(button.dataset.orderId || "")
    );
    renderKds();
    loadKdsOrders();
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

grid.addEventListener("click", (event) => {
  const button = event.target.closest(".kds-ready-button");

  if (button) {
    markOrderReady(button);
  }
});

applyCardSize();
loadKdsOrders();
setInterval(loadKdsOrders, 5000);
setInterval(renderKds, 1000);
