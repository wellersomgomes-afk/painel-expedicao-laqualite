let board = {
  updatedAt: "--:--",
  productionOrders: [],
  readyOrders: [],
  dispatchedOrders: [],
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
const driverForm = document.querySelector("#driver-form");
const driverNameInput = document.querySelector("#driver-name-input");
const driverList = document.querySelector("#driver-list");
const APP_TIME_ZONE = "America/Sao_Paulo";
const DUPLICATE_TIME_WINDOW_MINUTES = 10;
// Reativacao futura: incluir "esfihas" e "porcoes" aqui para voltar esses setores ao nosso KDS de producao.
const ACTIVE_PRODUCTION_SECTORS = ["pizzas"];
const DISPATCH_SECTORS = ["pizzas", "esfihas", "porcoes"];
let drivers = [];
let selectedDriverId = localStorage.getItem("kdsSelectedDriverId") || "";
let cardSize = localStorage.getItem("kdsCardSize") || "normal";
let activeView = localStorage.getItem("kdsActiveView") || "production";
let activeSector = localStorage.getItem("kdsActiveSector") || "pizzas";
let activeService = localStorage.getItem("kdsActiveService") || "both";
let isMenuHidden = localStorage.getItem("kdsMenuHidden") === "true";
let isSettingsOpen = false;
let searchOrderNumber = localStorage.getItem("kdsSearchOrderNumber") || "";
let shouldSyncOnNextKdsLoad = true;
let liveRefreshTimer = null;
const selectedDispatchOrders = new Set();

if (activeView === "dispatch") {
  activeView = "ready";
  activeSector = "dispatch";
  localStorage.setItem("kdsActiveView", activeView);
  localStorage.setItem("kdsActiveSector", activeSector);
}

if (!ACTIVE_PRODUCTION_SECTORS.includes(activeSector) && activeSector !== "dispatch") {
  activeSector = "pizzas";
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

function normalizeCustomerName(value) {
  return normalizeText(value)
    .trim()
    .replace(/\s+/g, " ");
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeAddress(value) {
  return normalizeCustomerName(value);
}

function isMeaningfulCustomerName(value) {
  const name = normalizeCustomerName(value);
  const genericNames = new Set(["cliente", "nao informado", "consumidor", "sem nome"]);

  return name.length >= 5 && !genericNames.has(name);
}

function isMeaningfulPhone(value) {
  return normalizePhone(value).length >= 8;
}

function isMeaningfulAddress(value) {
  const address = normalizeAddress(value);

  return address.length >= 8 && !address.includes("nao informado");
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

function orderDuplicateId(order) {
  return String(order.orderId || order.number || "");
}

function dispatchSelectionId(order) {
  return orderDuplicateId(order);
}

function selectedDriver() {
  return drivers.find((driver) => String(driver.id) === String(selectedDriverId)) || null;
}

function renderDriverOptions() {
  return [
    '<option value="">Selecione o motoboy</option>',
    ...drivers.map((driver) => `<option value="${driver.id}" ${String(driver.id) === String(selectedDriverId) ? "selected" : ""}>${driver.name}</option>`),
  ].join("");
}

function renderDriverList() {
  if (!driverList) {
    return;
  }

  if (drivers.length === 0) {
    driverList.innerHTML = '<span class="driver-empty">Nenhum motoboy cadastrado.</span>';
    return;
  }

  driverList.innerHTML = drivers.map((driver) => `
    <div class="driver-list-item">
      <strong>${driver.name}</strong>
      <button type="button" data-driver-id="${driver.id}">Remover</button>
    </div>
  `).join("");
}

function chooseDriverForDispatch() {
  return new Promise((resolve) => {
    if (drivers.length === 0) {
      alert("Cadastre um motoboy nas configuracoes antes de despachar.");
      resolve(null);
      return;
    }

    const overlay = document.createElement("div");
    overlay.className = "driver-modal-overlay";
    overlay.innerHTML = `
      <section class="driver-modal" role="dialog" aria-modal="true" aria-label="Selecionar motoboy">
        <header>
          <strong>Selecionar motoboy</strong>
          <button class="driver-modal-close" type="button" aria-label="Fechar">x</button>
        </header>
        <label>
          <span>Motoboy</span>
          <select class="driver-modal-select">
            ${renderDriverOptions()}
          </select>
        </label>
        <div class="driver-modal-actions">
          <button class="driver-modal-cancel" type="button">Cancelar</button>
          <button class="driver-modal-confirm" type="button">Confirmar despacho</button>
        </div>
      </section>
    `;

    const select = overlay.querySelector(".driver-modal-select");
    const close = () => {
      overlay.remove();
      resolve(null);
    };

    overlay.querySelector(".driver-modal-close").addEventListener("click", close);
    overlay.querySelector(".driver-modal-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        close();
      }
    });
    overlay.querySelector(".driver-modal-confirm").addEventListener("click", () => {
      const driver = drivers.find((item) => String(item.id) === String(select.value));

      if (!driver) {
        alert("Selecione um motoboy.");
        return;
      }

      selectedDriverId = driver.id;
      localStorage.setItem("kdsSelectedDriverId", selectedDriverId);
      overlay.remove();
      resolve(driver);
    });

    document.body.appendChild(overlay);
    select.focus();
  });
}

function duplicateNearbyOrders(sourceOrders) {
  const windowMs = DUPLICATE_TIME_WINDOW_MINUTES * 60000;
  const comparableOrders = sourceOrders
    .map((order) => ({
      id: orderDuplicateId(order),
      arrivedAt: Number(order.arrivedAt),
      identities: [
        isMeaningfulPhone(order.phone) ? normalizePhone(order.phone) : "",
        isMeaningfulAddress(order.address) ? normalizeAddress(order.address) : "",
        isMeaningfulCustomerName(order.customer) ? normalizeCustomerName(order.customer) : "",
      ].filter(Boolean),
    }))
    .filter((order) => order.id && Number.isFinite(order.arrivedAt) && order.identities.length > 0);
  const duplicates = new Set();

  comparableOrders.forEach((order, index) => {
    comparableOrders.slice(index + 1).forEach((otherOrder) => {
      const isNear = Math.abs(order.arrivedAt - otherOrder.arrivedAt) <= windowMs;
      const isSameClient = order.identities.some((identity) => otherOrder.identities.includes(identity));

      if (isNear && isSameClient) {
        duplicates.add(order.id);
        duplicates.add(otherOrder.id);
      }
    });
  });

  return duplicates;
}

function duplicateSignals(sourceOrders) {
  return {
    names: duplicateKeyCounts(sourceOrders, (order) =>
      isMeaningfulCustomerName(order.customer) ? normalizeCustomerName(order.customer) : ""
    ),
    phones: duplicateKeyCounts(sourceOrders, (order) =>
      isMeaningfulPhone(order.phone) ? normalizePhone(order.phone) : ""
    ),
    addresses: duplicateKeyCounts(sourceOrders, (order) =>
      isMeaningfulAddress(order.address) ? normalizeAddress(order.address) : ""
    ),
    nearby: duplicateNearbyOrders(sourceOrders),
  };
}

function isPossibleDuplicate(order, signals) {
  const phone = normalizePhone(order.phone);
  const address = normalizeAddress(order.address);
  const id = orderDuplicateId(order);

  return (
    (isMeaningfulPhone(order.phone) && (signals.phones.get(phone) || 0) > 1) ||
    (isMeaningfulAddress(order.address) && (signals.addresses.get(address) || 0) > 1) ||
    (id && signals.nearby.has(id))
  );
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
    .map((complement) => `${complement.name || ""} ${complement.category || ""} ${(complement.pdvCodes || []).join(" ")} ${(complement.categoryIds || []).join(" ")} ${complement.searchText || ""}`)
    .join(" ");

  return normalizeText(`${item.category || ""} ${item.name || ""} ${(item.pdvCodes || []).join(" ")} ${(item.categoryIds || []).join(" ")} ${item.description || ""} ${item.notes || ""} ${item.searchText || ""} ${complements}`);
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
  const sectors = sectorsForItem(item);

  return sectors[0] || "outros";
}

function sectorsForItem(item) {
  if (Array.isArray(item.sectors) && item.sectors.length > 0) {
    return item.sectors;
  }

  const categorySector = sectorFromCategory(normalizeText(item.category || ""));

  if (categorySector) {
    return [categorySector];
  }

  const text = itemSearchText(item);
  const sectors = new Set();

  if (hasAnyTerm(text, ["pizza", "pizzas"])) {
    sectors.add("pizzas");
  }

  if (hasAnyTerm(text, ["esfiha", "esfihas", "esfirra", "esfirras", "sfiha", "sfihas"])) {
    sectors.add("esfihas");
  }

  if (hasAnyTerm(text, ["porcao", "porcoes", "porc", "fritas", "batata", "mandioca", "onion", "aneis", "anel de cebola", "suco", "sucos"])) {
    sectors.add("porcoes");
  }

  if (
    sectors.size === 0 &&
    hasAnyTerm(text, ["combo 1", "combo 2", "combo 3", "combo 4", "combo de esfiha", "combo esfihas", "combo esfiha"])
  ) {
    sectors.add("esfihas");
  }

  return [...sectors];
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
    activeSector === "all"
      ? sectorsForItem(item).some((sector) => ACTIVE_PRODUCTION_SECTORS.includes(sector))
      : sectorsForItem(item).includes(activeSector)
  );

  if (items.length === 0) {
    return null;
  }

  return { ...order, items };
}

function filterOrderForDispatch(order) {
  const items = (order.items || []).filter((item) =>
    sectorsForItem(item).some((sector) => DISPATCH_SECTORS.includes(sector))
  );

  if (items.length === 0) {
    return null;
  }

  return { ...order, items };
}

function renderComplement(complement) {
  const highlightClass = isBorderText(complement.name) ? " kds-complement-border" : "";
  const quantity = Number(complement.quantity || 1);

  return `
    <li class="kds-complement${highlightClass}">
      <strong>${quantity > 1 ? `${formatQuantity(complement.quantity)}x` : ""}</strong>
      <span>${complement.name}</span>
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

function renderOrder(order, duplicateInfo = duplicateSignals([])) {
  const service = order.fulfillmentType === "pickup" ? "Retirada" : order.neighborhood || "Entrega";
  const isReadyView = activeView === "ready";
  const readyLabel = sectorReadyLabel();
  const isDuplicate = isPossibleDuplicate(order, duplicateInfo);

  return `
    <article class="kds-order-card${isReadyView ? " is-ready" : ""}${isDuplicate ? " has-duplicate-customer" : ""}" data-number="${order.number}" data-order-id="${order.orderId || ""}">
      <header class="kds-order-head">
        <div>
          <strong>#${order.number}</strong>
          <span>${order.customer || "Cliente"}</span>
          ${isDuplicate ? '<em class="duplicate-alert kds-duplicate-alert">Possível duplicado</em>' : ""}
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

function renderDispatchOrder(order, duplicateInfo = duplicateSignals([])) {
  const isPickup = isPickupOrder(order);
  const service = isPickup ? "Retirada" : order.neighborhood || "Entrega";
  const buttonLabel = isPickup ? "Pronto para retirada" : "Despachar";
  const isDuplicate = isPossibleDuplicate(order, duplicateInfo);
  const selectionId = dispatchSelectionId(order);
  const canBulkDispatch = isDispatchMode() && activeService === "delivery" && !isPickup;
  const isSelected = canBulkDispatch && selectedDispatchOrders.has(selectionId);

  return `
    <article class="dispatch-card${isDuplicate ? " has-duplicate-customer" : ""}${isSelected ? " is-selected" : ""}" data-number="${order.number}" data-order-id="${order.orderId || ""}">
      <header class="dispatch-card-head">
        <div class="dispatch-main">
          <strong>#${order.number}</strong>
          <span>${order.customer || "Não informado"}</span>
          ${isDuplicate ? '<em class="duplicate-alert kds-duplicate-alert">Possível duplicado</em>' : ""}
        </div>
        <div class="dispatch-head-actions">
          <div class="dispatch-time">${formatTimer(order)}</div>
          ${canBulkDispatch ? `
            <button
              class="dispatch-select-button"
              type="button"
              data-selection-id="${selectionId}"
              aria-pressed="${isSelected}"
            >
              ${isSelected ? "Selecionado" : "Selecionar"}
            </button>
          ` : ""}
        </div>
      </header>
      <button
        class="kds-dispatch-button dispatch-top-action${isPickup ? " pickup" : ""}"
        type="button"
        data-number="${order.number}"
        data-order-id="${order.orderId || ""}"
        data-action="${isPickup ? "pickup-ready" : "dispatch"}"
      >
        ${buttonLabel}
      </button>
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
    </article>
  `;
}

function formatDispatchedTime(order) {
  if (!order.dispatchedAt) {
    return "";
  }

  return new Date(Number(order.dispatchedAt)).toLocaleTimeString("pt-BR", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderDispatchedOrder(order) {
  const isPickup = isPickupOrder(order);
  const service = isPickup ? "Retirada" : "Entrega";
  const location = isPickup ? "Balcao" : order.neighborhood || "Bairro nao informado";

  return `
    <article class="dispatch-card dispatched-kds-card">
      <header class="dispatch-card-head">
        <div class="dispatch-main">
          <strong>#${order.number}</strong>
          <span>${order.customer || "Nao informado"}</span>
        </div>
        <div class="dispatch-time">${formatDispatchedTime(order)}</div>
      </header>
      <div class="dispatched-kds-body">
        <div>
          <span>Tipo</span>
          <strong>${service}</strong>
        </div>
        <div>
          <span>Local</span>
          <strong>${location}</strong>
        </div>
        <div>
          <span>Motoboy</span>
          <strong>${order.driverName || (isPickup ? "Retirada" : "Nao informado")}</strong>
        </div>
      </div>
    </article>
  `;
}

function isPickupOrder(order) {
  return order.fulfillmentType === "pickup";
}

function renderOrderSection(title, orders, renderer = renderOrder, duplicateInfo = duplicateSignals([])) {
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
        ${orders.map((order) => renderer(order, duplicateInfo)).join("")}
      </div>
    </section>
  `;
}

function renderBulkDispatchBar(orders) {
  const deliveryOrders = orders.filter((order) => !isPickupOrder(order));
  const validIds = new Set(deliveryOrders.map(dispatchSelectionId));

  [...selectedDispatchOrders].forEach((id) => {
    if (!validIds.has(id)) {
      selectedDispatchOrders.delete(id);
    }
  });

  const selectedCount = deliveryOrders.filter((order) => selectedDispatchOrders.has(dispatchSelectionId(order))).length;
  const hasOrders = deliveryOrders.length > 0;

  return `
    <section class="bulk-dispatch-bar" aria-label="Despacho em massa">
      <div>
        <strong>Despacho em massa</strong>
        <span>${selectedCount} de ${deliveryOrders.length} entregas selecionadas</span>
      </div>
      <div class="bulk-dispatch-actions">
        <button class="bulk-select-all" type="button" ${hasOrders ? "" : "disabled"}>Selecionar ate 6</button>
        <button class="bulk-clear-selection" type="button" ${selectedCount ? "" : "disabled"}>Limpar</button>
        <button class="bulk-dispatch-button" type="button" ${selectedCount ? "" : "disabled"}>Despachar selecionados</button>
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
    const isProductionSector = button.dataset.sector !== "dispatch" && button.dataset.sector !== "all";
    const isDisabledSector = isProductionSector && !ACTIVE_PRODUCTION_SECTORS.includes(button.dataset.sector);

    button.hidden = isDisabledSector || button.dataset.sector === "all";
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
  const dispatchedMode = dispatchMode && activeService === "dispatched";
  const sourceOrders = dispatchMode && activeService === "dispatched"
    ? board.dispatchedOrders
    : activeView === "ready" || dispatchMode
      ? board.readyOrders
      : board.productionOrders;
  const searchValue = searchOrderNumber.trim();

  return sourceOrders
    .filter((order) => !dispatchMode || activeService === "dispatched" || order.readyAt)
    .filter((order) => !searchValue || String(order.number || "").includes(searchValue))
    .filter((order) =>
      activeService === "both" ||
      activeService === "dispatched" ||
      (activeService === "pickup" && isPickupOrder(order)) ||
      (activeService === "delivery" && !isPickupOrder(order))
    )
    .map((order) => {
      if (dispatchMode && activeService === "dispatched") {
        return order;
      }

      return dispatchMode ? filterOrderForDispatch(order) : filterOrderForSector(order);
    })
    .filter(Boolean)
    .sort((left, right) => Number(left.number || 0) - Number(right.number || 0));
}

function ordersForSummary(sourceOrders, { dispatchMode = false } = {}) {
  return sourceOrders
    .filter((order) => !dispatchMode || order.readyAt)
    .filter((order) =>
      activeService === "both" ||
      activeService === "dispatched" ||
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
  const duplicateInfo = duplicateSignals(orders);
  const productionSummaryOrders = ordersForSummary(board.productionOrders, { dispatchMode: false });
  const readySummaryOrders = dispatchMode && activeService === "dispatched"
    ? board.dispatchedOrders
    : ordersForSummary(board.readyOrders, { dispatchMode });

  if (searchInput && searchInput.value !== searchOrderNumber) {
    searchInput.value = searchOrderNumber;
  }

  productionCount.textContent = String(productionSummaryOrders.length);
  readyCount.textContent = String(readySummaryOrders.length);
  averageTime.textContent = dispatchMode && activeService === "dispatched"
    ? "--:--"
    : averagePreparationTime(readySummaryOrders);

  if (orders.length === 0) {
    if (dispatchMode && activeService === "dispatched") {
      grid.innerHTML = '<div class="empty kds-empty">Nenhum pedido despachado ainda.</div>';
      return;
    }

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
    if (activeService === "dispatched") {
      grid.innerHTML = renderOrderSection("Despachados", orders, renderDispatchedOrder, duplicateInfo);
      return;
    }

    if (activeService === "both") {
      grid.innerHTML = renderOrderSection("Despacho", orders, renderDispatchOrder, duplicateInfo);
      return;
    }

    const dispatchTitle = activeService === "pickup" ? "Retiradas prontas" : "Entregas prontas";
    grid.innerHTML = `${activeService === "delivery" ? renderBulkDispatchBar(orders) : ""}${renderOrderSection(dispatchTitle, orders, renderDispatchOrder, duplicateInfo)}`;
    return;
  }

  if (activeService === "both") {
    grid.innerHTML = renderOrderSection("Pedidos", orders, renderOrder, duplicateInfo);
    return;
  }

  const sectionTitle = activeService === "pickup" ? "Retiradas" : "Entregas";
  grid.innerHTML = renderOrderSection(sectionTitle, orders, renderOrder, duplicateInfo);
}

async function loadKdsOrders() {
  try {
    const [productionResponse, readyResponse, dispatchedResponse] = await Promise.all([
      fetch(shouldSyncOnNextKdsLoad ? "/api/kds-orders?sync=1" : "/api/kds-orders"),
      fetch("/api/kds-ready-orders"),
      fetch("/api/dispatched-orders"),
    ]);
    shouldSyncOnNextKdsLoad = false;
    const productionData = await productionResponse.json();
    const readyData = await readyResponse.json();
    const dispatchedData = await dispatchedResponse.json();

    board = {
      updatedAt: productionData.updatedAt || readyData.updatedAt || "--:--",
      productionOrders: Array.isArray(productionData.orders) ? productionData.orders : [],
      readyOrders: Array.isArray(readyData.orders) ? readyData.orders : [],
      dispatchedOrders: Array.isArray(dispatchedData.orders) ? dispatchedData.orders : [],
    };
  } catch (error) {
    shouldSyncOnNextKdsLoad = false;
    board = {
      updatedAt: "--:--",
      productionOrders: [],
      readyOrders: [],
      dispatchedOrders: [],
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

    await response.json().catch(() => ({}));

    await loadKdsOrders();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Pronto";
    alert(error.message || "Nao foi possivel marcar pronto no KDS.");
  }
}

async function loadDrivers() {
  try {
    const response = await fetch("/api/drivers");
    const data = await response.json();
    drivers = Array.isArray(data.drivers) ? data.drivers : [];

    if (selectedDriverId && !selectedDriver()) {
      selectedDriverId = "";
      localStorage.removeItem("kdsSelectedDriverId");
    }

    renderDriverList();
    renderKds();
  } catch (error) {
    drivers = [];
    renderDriverList();
  }
}

function scheduleLiveRefresh() {
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(() => {
    loadKdsOrders();
    loadDrivers();
  }, 150);
}

function connectLiveUpdates() {
  if (!window.EventSource) {
    return;
  }

  const source = new EventSource("/api/updates");
  source.addEventListener("update", scheduleLiveRefresh);
}

async function addDriver(name) {
  const response = await fetch("/api/drivers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.message || "Nao foi possivel cadastrar o motoboy.");
  }

  await loadDrivers();
}

async function deleteDriver(driverId) {
  const response = await fetch("/api/drivers", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: driverId }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.message || "Nao foi possivel remover o motoboy.");
  }

  if (String(selectedDriverId) === String(driverId)) {
    selectedDriverId = "";
    localStorage.removeItem("kdsSelectedDriverId");
  }

  await loadDrivers();
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

    await response.json().catch(() => ({}));

    await loadKdsOrders();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Produto pronto";
    alert(error.message || "Nao foi possivel marcar produto pronto no KDS.");
  }
}

async function dispatchReadyOrder(button) {
  const driver = button.dataset.action === "dispatch" ? await chooseDriverForDispatch() : null;

  if (button.dataset.action === "dispatch" && !driver) {
    return;
  }

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
        driverId: driver?.id || "",
        driverName: driver?.name || "",
      }),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.message || "Falha no despacho");
    }

    await loadKdsOrders();
  } catch (error) {
    button.disabled = false;
    button.textContent = button.dataset.action === "pickup-ready" ? "Pronto para retirada" : "Despachar";
    alert(error.message || "Nao foi possivel atualizar o Cardapio Web.");
  }
}

async function dispatchSelectedOrders(button) {
  const driver = await chooseDriverForDispatch();

  if (!driver) {
    return;
  }

  const selectedIds = new Set(selectedDispatchOrders);
  const selectedOrders = currentOrders()
    .filter((order) => !isPickupOrder(order))
    .filter((order) => selectedIds.has(dispatchSelectionId(order)))
    .slice(0, 6);

  if (selectedOrders.length === 0) {
    return;
  }

  button.disabled = true;
  button.textContent = `Despachando ${selectedOrders.length}...`;
  let failedMessage = "";

  for (const order of selectedOrders) {
    try {
      const response = await fetch("/api/kds-dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          number: order.number,
          orderId: order.orderId || "",
          action: "dispatch",
          driverId: driver.id,
          driverName: driver.name,
        }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.message || `Falha ao despachar o pedido #${order.number}`);
      }

      selectedDispatchOrders.delete(dispatchSelectionId(order));
    } catch (error) {
      failedMessage = error.message || `Falha ao despachar o pedido #${order.number}`;
      break;
    }
  }

  await loadKdsOrders();

  if (failedMessage) {
    alert(failedMessage);
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
    if (button.hidden) {
      return;
    }

    activeSector = button.dataset.sector;
    localStorage.setItem("kdsActiveSector", activeSector);
    if (activeSector === "dispatch") {
      activeView = "ready";
      localStorage.setItem("kdsActiveView", activeView);
    } else if (activeService === "dispatched") {
      activeService = "both";
      localStorage.setItem("kdsActiveService", activeService);
    }
    renderKds();
  });
});

serviceTabs.forEach((button) => {
  button.addEventListener("click", () => {
    activeService = button.dataset.service;
    localStorage.setItem("kdsActiveService", activeService);
    if (activeService === "dispatched") {
      activeSector = "dispatch";
      activeView = "ready";
      localStorage.setItem("kdsActiveSector", activeSector);
      localStorage.setItem("kdsActiveView", activeView);
    }
    selectedDispatchOrders.clear();
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

if (driverForm) {
  driverForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = driverNameInput?.value || "";

    try {
      await addDriver(name);
      if (driverNameInput) {
        driverNameInput.value = "";
        driverNameInput.focus();
      }
    } catch (error) {
      alert(error.message || "Nao foi possivel cadastrar o motoboy.");
    }
  });
}

if (driverList) {
  driverList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-driver-id]");

    if (!button) {
      return;
    }

    try {
      await deleteDriver(button.dataset.driverId);
    } catch (error) {
      alert(error.message || "Nao foi possivel remover o motoboy.");
    }
  });
}

grid.addEventListener("click", (event) => {
  const itemButton = event.target.closest(".kds-item-ready-button");
  const orderButton = event.target.closest(".kds-ready-button");
  const dispatchButton = event.target.closest(".kds-dispatch-button");
  const selectDispatchButton = event.target.closest(".dispatch-select-button");
  const bulkSelectAllButton = event.target.closest(".bulk-select-all");
  const bulkClearButton = event.target.closest(".bulk-clear-selection");
  const bulkDispatchButton = event.target.closest(".bulk-dispatch-button");

  if (itemButton) {
    markItemReady(itemButton);
    return;
  }

  if (orderButton) {
    markOrderReady(orderButton);
    return;
  }

  if (selectDispatchButton) {
    const selectionId = selectDispatchButton.dataset.selectionId;

    if (selectedDispatchOrders.has(selectionId)) {
      selectedDispatchOrders.delete(selectionId);
    } else if (selectedDispatchOrders.size >= 6) {
      alert("Selecione no maximo 6 entregas por vez.");
    } else {
      selectedDispatchOrders.add(selectionId);
    }

    renderKds();
    return;
  }

  if (bulkSelectAllButton) {
    currentOrders()
      .filter((order) => !isPickupOrder(order))
      .slice(0, 6)
      .forEach((order) => selectedDispatchOrders.add(dispatchSelectionId(order)));
    renderKds();
    return;
  }

  if (bulkClearButton) {
    selectedDispatchOrders.clear();
    renderKds();
    return;
  }

  if (bulkDispatchButton) {
    dispatchSelectedOrders(bulkDispatchButton);
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
loadDrivers();
connectLiveUpdates();
setInterval(loadKdsOrders, 5000);
setInterval(renderKds, 1000);
