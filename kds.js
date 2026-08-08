let board = {
  updatedAt: "--:--",
  productionOrders: [],
  readyOrders: [],
};

const productionCount = document.querySelector("#kds-production-count");
const readyCount = document.querySelector("#kds-ready-count");
const averageTime = document.querySelector("#kds-average-time");
const grid = document.querySelector("#kds-grid");
const sizeButtons = document.querySelectorAll(".kds-size-button");
const viewTabs = document.querySelectorAll(".kds-view-tab");
const productTabs = document.querySelectorAll(".kds-product-tab");
const serviceTabs = document.querySelectorAll(".kds-service-tab");
const fullscreenButton = document.querySelector("#kds-fullscreen-button");
const menuToggle = document.querySelector("#kds-menu-toggle");
const menuRestore = document.querySelector("#kds-menu-restore");
const settingsButton = document.querySelector("#kds-settings-button");
const settingsPanel = document.querySelector("#kds-settings-panel");
const searchInput = document.querySelector("#kds-search-input");
const searchClearButton = document.querySelector("#kds-search-clear");
const APP_TIME_ZONE = "America/Sao_Paulo";
let cardSize = localStorage.getItem("kdsCardSize") || "normal";
let activeView = localStorage.getItem("kdsActiveView") || "production";
let activeSector = localStorage.getItem("kdsActiveSector") || "pizzas";
let activeService = localStorage.getItem("kdsActiveService") || "both";
let isMenuHidden = localStorage.getItem("kdsMenuHidden") === "true";
let isSettingsOpen = false;
let searchOrderNumber = localStorage.getItem("kdsSearchOrderNumber") || "";
let shouldSyncOnNextKdsLoad = true;

if (activeView === "dispatch") {
  activeView = "ready";
  activeSector = "dispatch";
  localStorage.setItem("kdsActiveView", activeView);
  localStorage.setItem("kdsActiveSector", activeSector);
}

function elapsedSeconds(order) {
  return Math.max(Math.floor((Date.now() - Number(order.arrivedAt || Date.now())) / 1000), 0);
}

function formatTimer(order) {
  const totalSeconds = elapsedSeconds(order);
  return formatSeconds(totalSeconds);
}

function formatSeconds(totalSeconds) {
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
    timeZone: APP_TIME_ZONE,
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
  const category = normalizeText(item.category || "");
  const name = normalizeText(item.name || "");

  return category.includes("pizza") || name.includes("pizza");
}

function itemSearchText(item) {
  const complements = (item.complements || [])
    .map((complement) => `${complement.name || ""} ${complement.category || ""}`)
    .join(" ");

  return normalizeText(`${item.category || ""} ${item.name || ""} ${item.description || ""} ${item.notes || ""} ${complements}`);
}

function hasAnyTerm(text, terms) {
  return terms.some((term) => text.includes(term));
}

function sectorFromCategory(categoryText) {
  if (hasAnyTerm(categoryText, ["porcao", "porcoes", "porc", "suco", "sucos"])) {
    return "porcoes";
  }

  if (hasAnyTerm(categoryText, ["esfiha", "esfihas", "esfirra", "esfirras", "sfiha", "sfihas"])) {
    return "esfihas";
  }

  if (hasAnyTerm(categoryText, ["pizza", "pizzas"])) {
    return "pizzas";
  }

  return "";
}

function sectorForItem(item) {
  const categorySector = sectorFromCategory(normalizeText(item.category || ""));

  if (categorySector) {
    return categorySector;
  }

  const text = itemSearchText(item);

  if (hasAnyTerm(text, ["pizza", "pizzas"])) {
    return "pizzas";
  }

  if (hasAnyTerm(text, ["esfiha", "esfihas", "esfirra", "esfirras", "sfiha", "sfihas"])) {
    return "esfihas";
  }

  if (hasAnyTerm(text, ["porcao", "porcoes", "porc", "fritas", "batata", "mandioca", "onion", "aneis", "anel de cebola", "suco", "sucos"])) {
    return "porcoes";
  }

  return "outros";
}

function sectorLabel() {
  const labels = {
    all: "Todos os setores",
    pizzas: "Pizzas",
    esfihas: "Esfihas",
    porcoes: "Porções",
  };

  return labels[activeSector] || "Produção";
}

function sectorReadyLabel() {
  const labels = {
    all: "Produção pronta",
    pizzas: "Pizzas prontas",
    esfihas: "Esfihas prontas",
    porcoes: "Porções prontas",
    dispatch: "Despacho",
  };

  return labels[activeSector] || "Setor pronto";
}

function isDispatchMode() {
  return activeSector === "dispatch";
}

function filterOrderForSector(order) {
  const items = (order.items || []).filter((item) =>
    activeSector === "all" ? ["pizzas", "esfihas", "porcoes"].includes(sectorForItem(item)) : sectorForItem(item) === activeSector
  );

  if (items.length === 0) {
    return null;
  }

  return { ...order, items };
}

function filterOrderForDispatch(order) {
  const items = (order.items || []).filter((item) => ["pizzas", "esfihas", "porcoes"].includes(sectorForItem(item)));

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

function renderItem(item, order) {
  const complements = item.complements || [];
  const hasBorderHighlight = isBorderText(item.name) || complements.some((complement) => isBorderText(complement.name));
  const quantity = Number(item.quantity || 0);
  const quantityClass = quantity >= 2 ? " kds-quantity-alert" : "";
  const shouldShowItemReady = activeView === "production" && order.items.length >= 2;

  return `
    <article class="kds-order-item${hasBorderHighlight ? " has-border" : ""}">
      <div class="kds-product-line">
        <strong class="kds-quantity${quantityClass}">${formatQuantity(item.quantity)}x</strong>
        <span>${item.name}</span>
      </div>
      ${complements.length > 0 ? `
        <ul class="kds-complements">
          ${complements.map(renderComplement).join("")}
        </ul>
      ` : ""}
      ${item.notes ? renderItemNote(item.notes) : ""}
      ${shouldShowItemReady ? `
        <button
          class="kds-item-ready-button"
          type="button"
          data-number="${order.number}"
          data-order-id="${order.orderId || ""}"
          data-item-key="${item.kdsItemKey || ""}"
        >
          Produto pronto
        </button>
      ` : ""}
    </article>
  `;
}

function renderOrder(order) {
  const service = order.fulfillmentType === "pickup" ? "Retirada" : order.neighborhood || "Entrega";
  const isReadyView = activeView === "ready";
  const readyLabel = sectorReadyLabel();

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
      <div class="kds-order-items">
        ${order.items.map((item) => renderItem(item, order)).join("")}
      </div>
      ${isReadyView ? `
        <div class="kds-ready-stamp">Pedido pronto</div>
      ` : `
        <button
          class="kds-ready-button"
          type="button"
          data-number="${order.number}"
          data-order-id="${order.orderId || ""}"
          data-item-keys="${order.items.map((item) => item.kdsItemKey || "").filter(Boolean).join(",")}"
        >
          ${readyLabel}
        </button>
      `}
    </article>
  `;
}

function renderDispatchOrder(order) {
  const isPickup = isPickupOrder(order);
  const service = isPickup ? "Retirada" : order.neighborhood || "Entrega";
  const buttonLabel = isPickup ? "Pronto para retirada" : "Despachar";
  const statusText = isPickup ? "Disponível para retirada" : "Pronto para despacho";

  return `
    <article class="dispatch-card" data-number="${order.number}" data-order-id="${order.orderId || ""}">
      <header class="dispatch-card-head">
        <div class="dispatch-main">
          <strong>#${order.number}</strong>
          <span>${order.customer || "Não informado"}</span>
        </div>
        <div class="dispatch-time">${formatTimer(order)}</div>
      </header>
      <div class="dispatch-state">${statusText}</div>
      <div class="dispatch-items">
        ${order.items.map((item) => `
          <article class="dispatch-item">
            <div class="dispatch-item-line">
              <strong>${formatQuantity(item.quantity)}</strong>
              <span>${item.name}</span>
            </div>
            ${(item.complements || []).map((complement) => `
              <div class="dispatch-detail">- ${complement.name}</div>
            `).join("")}
            ${item.notes ? `<div class="dispatch-note">Obs: ${item.notes}</div>` : ""}
          </article>
        `).join("")}
      </div>
      <button
        class="kds-dispatch-button${isPickup ? " pickup" : ""}"
        type="button"
        data-number="${order.number}"
        data-order-id="${order.orderId || ""}"
        data-action="${isPickup ? "pickup-ready" : "dispatch"}"
      >
        ${buttonLabel}
      </button>
    </article>
  `;
}

function isPickupOrder(order) {
  return order.fulfillmentType === "pickup";
}

function renderOrderSection(title, orders, renderer = renderOrder) {
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
        ${orders.map(renderer).join("")}
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

function applyActiveSector() {
  productTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.sector === activeSector);
  });
}

function applyActiveService() {
  serviceTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.service === activeService);
  });
}

function applyMenuVisibility() {
  document.body.classList.toggle("kds-menu-hidden", isMenuHidden);

  if (menuToggle) {
    menuToggle.textContent = isMenuHidden ? "Mostrar menu" : "Ocultar menu";
  }
}

function setSettingsOpen(isOpen) {
  isSettingsOpen = isOpen;

  if (settingsPanel) {
    settingsPanel.hidden = !isSettingsOpen;
  }

  if (settingsButton) {
    settingsButton.setAttribute("aria-expanded", String(isSettingsOpen));
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

function currentOrders() {
  const dispatchMode = isDispatchMode();
  const sourceOrders = activeView === "ready" || dispatchMode ? board.readyOrders : board.productionOrders;
  const searchValue = searchOrderNumber.trim();

  return sourceOrders
    .filter((order) => !dispatchMode || order.readyAt)
    .filter((order) => !searchValue || String(order.number || "").includes(searchValue))
    .filter((order) =>
      activeService === "both" ||
      (activeService === "pickup" && isPickupOrder(order)) ||
      (activeService === "delivery" && !isPickupOrder(order))
    )
    .map((order) => dispatchMode ? filterOrderForDispatch(order) : filterOrderForSector(order))
    .filter(Boolean)
    .sort((left, right) => Number(left.number || 0) - Number(right.number || 0));
}

function ordersForSummary(sourceOrders, { dispatchMode = false } = {}) {
  return sourceOrders
    .filter((order) => !dispatchMode || order.readyAt)
    .filter((order) =>
      activeService === "both" ||
      (activeService === "pickup" && isPickupOrder(order)) ||
      (activeService === "delivery" && !isPickupOrder(order))
    )
    .map((order) => dispatchMode ? filterOrderForDispatch(order) : filterOrderForSector(order))
    .filter(Boolean);
}

function averagePreparationTime(orders) {
  const finishedTimes = orders
    .map((order) => {
      const arrivedAt = Number(order.arrivedAt || 0);
      const readyAt = Number(order.readyAt || 0);

      if (!arrivedAt || !readyAt || readyAt <= arrivedAt) {
        return null;
      }

      return Math.floor((readyAt - arrivedAt) / 1000);
    })
    .filter((value) => Number.isFinite(value));

  if (finishedTimes.length === 0) {
    return "--:--";
  }

  const averageSeconds = Math.round(finishedTimes.reduce((total, value) => total + value, 0) / finishedTimes.length);
  return formatSeconds(averageSeconds);
}

function renderKds() {
  const dispatchMode = isDispatchMode();
  document.body.classList.toggle("kds-dispatch-mode", dispatchMode);
  applyCardSize();
  applyActiveView();
  applyActiveSector();
  applyActiveService();
  const orders = currentOrders();
  const productionSummaryOrders = ordersForSummary(board.productionOrders, { dispatchMode: false });
  const readySummaryOrders = ordersForSummary(board.readyOrders, { dispatchMode });

  if (searchInput && searchInput.value !== searchOrderNumber) {
    searchInput.value = searchOrderNumber;
  }

  productionCount.textContent = String(productionSummaryOrders.length);
  readyCount.textContent = String(readySummaryOrders.length);
  averageTime.textContent = averagePreparationTime(readySummaryOrders);

  if (orders.length === 0) {
    grid.innerHTML = searchOrderNumber
      ? `<div class="empty kds-empty">Nenhum pedido encontrado com o número ${searchOrderNumber}.</div>`
      : dispatchMode
      ? '<div class="empty kds-empty">Nenhum pedido pronto para despacho no momento.</div>'
      : activeView === "ready"
        ? `<div class="empty kds-empty">Nenhum item de ${sectorLabel().toLowerCase()} pronto no momento.</div>`
        : `<div class="empty kds-empty">Nenhum item de ${sectorLabel().toLowerCase()} em producao no momento.</div>`;
    return;
  }

  if (dispatchMode) {
    if (activeService === "both") {
      grid.innerHTML = renderOrderSection("Despacho", orders, renderDispatchOrder);
      return;
    }

    const dispatchTitle = activeService === "pickup" ? "Retiradas prontas" : "Entregas prontas";
    grid.innerHTML = renderOrderSection(dispatchTitle, orders, renderDispatchOrder);
    return;
  }

  if (activeService === "both") {
    grid.innerHTML = renderOrderSection("Pedidos", orders);
    return;
  }

  const sectionTitle = activeService === "pickup" ? "Retiradas" : "Entregas";
  grid.innerHTML = renderOrderSection(sectionTitle, orders);
}

async function loadKdsOrders() {
  try {
    const [productionResponse, readyResponse] = await Promise.all([
      fetch(shouldSyncOnNextKdsLoad ? "/api/kds-orders?sync=1" : "/api/kds-orders"),
      fetch("/api/kds-ready-orders"),
    ]);
    shouldSyncOnNextKdsLoad = false;
    const productionData = await productionResponse.json();
    const readyData = await readyResponse.json();

    board = {
      updatedAt: productionData.updatedAt || readyData.updatedAt || "--:--",
      productionOrders: Array.isArray(productionData.orders) ? productionData.orders : [],
      readyOrders: Array.isArray(readyData.orders) ? readyData.orders : [],
    };
  } catch (error) {
    shouldSyncOnNextKdsLoad = false;
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
        itemKeys: button.dataset.itemKeys ? button.dataset.itemKeys.split(",").filter(Boolean) : [],
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

async function markItemReady(button) {
  button.disabled = true;
  button.textContent = "Salvando...";

  try {
    const response = await fetch("/api/kds-item-ready", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: button.dataset.number,
        orderId: button.dataset.orderId,
        itemKey: button.dataset.itemKey,
      }),
    });

    if (!response.ok) {
      throw new Error("Falha ao marcar produto pronto");
    }

    await loadKdsOrders();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Produto pronto";
  }
}

async function dispatchReadyOrder(button) {
  button.disabled = true;
  button.textContent = "Salvando...";

  try {
    const response = await fetch("/api/kds-dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: button.dataset.number,
        orderId: button.dataset.orderId,
        action: button.dataset.action,
      }),
    });

    if (!response.ok) {
      throw new Error("Falha no despacho");
    }

    await loadKdsOrders();
  } catch (error) {
    button.disabled = false;
    button.textContent = button.dataset.action === "pickup-ready" ? "Pronto para retirada" : "Despachar";
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

productTabs.forEach((button) => {
  button.addEventListener("click", () => {
    activeSector = button.dataset.sector;
    localStorage.setItem("kdsActiveSector", activeSector);
    if (activeSector === "dispatch") {
      activeView = "ready";
      localStorage.setItem("kdsActiveView", activeView);
    }
    renderKds();
  });
});

serviceTabs.forEach((button) => {
  button.addEventListener("click", () => {
    activeService = button.dataset.service;
    localStorage.setItem("kdsActiveService", activeService);
    renderKds();
  });
});

if (fullscreenButton) {
  fullscreenButton.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", updateFullscreenButton);
}

if (menuToggle) {
  menuToggle.addEventListener("click", () => {
    isMenuHidden = !isMenuHidden;
    localStorage.setItem("kdsMenuHidden", String(isMenuHidden));
    setSettingsOpen(false);
    applyMenuVisibility();
  });
}

if (menuRestore) {
  menuRestore.addEventListener("click", () => {
    isMenuHidden = false;
    localStorage.setItem("kdsMenuHidden", String(isMenuHidden));
    applyMenuVisibility();
  });
}

if (settingsButton) {
  settingsButton.addEventListener("click", () => {
    setSettingsOpen(!isSettingsOpen);
  });
}

document.addEventListener("click", (event) => {
  if (!isSettingsOpen || event.target.closest(".kds-settings")) {
    return;
  }

  setSettingsOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setSettingsOpen(false);
  }
});

if (searchInput) {
  searchInput.value = searchOrderNumber;
  searchInput.addEventListener("input", () => {
    searchOrderNumber = searchInput.value.replace(/\D/g, "");
    searchInput.value = searchOrderNumber;
    localStorage.setItem("kdsSearchOrderNumber", searchOrderNumber);
    renderKds();
  });
}

if (searchClearButton) {
  searchClearButton.addEventListener("click", () => {
    searchOrderNumber = "";
    localStorage.removeItem("kdsSearchOrderNumber");
    if (searchInput) {
      searchInput.value = "";
      searchInput.focus();
    }
    renderKds();
  });
}

grid.addEventListener("click", (event) => {
  const itemButton = event.target.closest(".kds-item-ready-button");
  const orderButton = event.target.closest(".kds-ready-button");
  const dispatchButton = event.target.closest(".kds-dispatch-button");

  if (itemButton) {
    markItemReady(itemButton);
    return;
  }

  if (orderButton) {
    markOrderReady(orderButton);
    return;
  }

  if (dispatchButton) {
    dispatchReadyOrder(dispatchButton);
  }
});

applyCardSize();
applyActiveView();
applyActiveSector();
applyActiveService();
applyMenuVisibility();
setSettingsOpen(false);
updateFullscreenButton();
loadKdsOrders();
setInterval(loadKdsOrders, 5000);
setInterval(renderKds, 1000);
