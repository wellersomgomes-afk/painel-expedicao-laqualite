let summary = {
  orderCount: 0,
  updatedAt: "--:--",
  groups: [],
};

const orderCount = document.querySelector("#kds-order-count");
const updatedAt = document.querySelector("#kds-updated-at");
const grid = document.querySelector("#kds-grid");

function formatQuantity(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    maximumFractionDigits: 2,
  });
}

function renderGroup(group) {
  const detailParts = [];

  if (group.units > 0) {
    detailParts.push(`${formatQuantity(group.units)} un`);
  }

  if (group.combos > 0) {
    detailParts.push(`${formatQuantity(group.combos)} combos`);
  }

  if (detailParts.length === 0) {
    detailParts.push("0 un");
  }

  return `
    <article class="kds-card kds-${group.key}">
      <header>
        <span>${group.label}</span>
        <strong>${detailParts.join(" e ")}</strong>
      </header>
      <div class="kds-meta">${group.commands} comandas</div>
      <div class="kds-items">
        ${group.items.slice(0, 8).map((item) => `
          <div class="kds-item">
            <span>${item.name}</span>
            <strong>${formatQuantity(item.quantity)}</strong>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function renderKds() {
  orderCount.textContent = String(summary.orderCount || 0);
  updatedAt.textContent = summary.updatedAt || "--:--";

  if (!summary.groups || summary.groups.length === 0) {
    grid.innerHTML = '<div class="empty kds-empty">Nenhum produto em produção no momento.</div>';
    return;
  }

  grid.innerHTML = summary.groups.map(renderGroup).join("");
}

async function loadProductionSummary() {
  try {
    const response = await fetch("/api/production-summary");
    summary = await response.json();
  } catch (error) {
    summary = {
      orderCount: 0,
      updatedAt: "--:--",
      groups: [],
    };
  }

  renderKds();
}

loadProductionSummary();
setInterval(loadProductionSummary, 5000);
