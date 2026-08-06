let summary = {
  updatedAt: "--:--",
  orders: [],
};

const orderCount = document.querySelector("#kds-order-count");
const updatedAt = document.querySelector("#kds-updated-at");
const grid = document.querySelector("#kds-grid");

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
  const text = normalizeText(value);

  return text.includes("borda");
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

function renderItem(item) {
  const notes = item.notes ? [{ name: item.notes, quantity: 1 }] : [];
  const complements = [...(item.complements || []), ...notes];
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
    </article>
  `;
}

function renderOrder(order) {
  const service = order.fulfillmentType === "pickup" ? "Retirada" : order.neighborhood || "Entrega";

  return `
    <article class="kds-order-card">
      <header class="kds-order-head">
        <div>
          <strong>#${order.number}</strong>
          <span>${order.customer || "Cliente"}</span>
        </div>
        <div class="kds-order-time">${formatTimer(order)}</div>
      </header>
      <div class="kds-service">${service}</div>
      <div class="kds-order-items">
        ${order.items.map(renderItem).join("")}
      </div>
    </article>
  `;
}

function renderKds() {
  orderCount.textContent = String(summary.orders?.length || 0);
  updatedAt.textContent = summary.updatedAt || "--:--";

  if (!summary.orders || summary.orders.length === 0) {
    grid.innerHTML = '<div class="empty kds-empty">Nenhum pedido em produção no momento.</div>';
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

loadKdsOrders();
setInterval(loadKdsOrders, 5000);
setInterval(renderKds, 1000);
