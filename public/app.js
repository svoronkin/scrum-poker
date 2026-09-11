(() => {
  const CARDS = ["0", "1", "2", "3", "5", "8", "13", "21", "☕", "⚰️✝️🏳️‍🌈"];
  const GRAVE_CARD = "⚰️✝️🏳️‍🌈";
  const GRAVE_PARTS = ["⚰️", "✝️", "🏳️‍🌈"];
  const gate = document.getElementById("gate");
  const table = document.getElementById("table");
  const joinForm = document.getElementById("join-form");
  const nameInput = document.getElementById("name-input");
  const roomInput = document.getElementById("room-input");
  const roomLabel = document.getElementById("room-label");
  const youName = document.getElementById("you-name");
  const taskInput = document.getElementById("task-input");
  const seatsEl = document.getElementById("seats");
  const deckWrap = document.getElementById("deck-wrap");
  const storyEdit = document.getElementById("story-edit");
  const taskTitle = document.getElementById("task-title");
  const taskHint = document.getElementById("task-hint");
  const voteCount = document.getElementById("vote-count");
  const summaryEl = document.getElementById("summary");
  const deckEl = document.getElementById("deck");
  const pickHint = document.getElementById("pick-hint");
  const toastEl = document.getElementById("toast");
  const revealBtn = document.getElementById("reveal");
  const resetBtn = document.getElementById("reset");
  const clearBtn = document.getElementById("clear-table");
  const saveTaskBtn = document.getElementById("save-task");
  const copyLinkBtn = document.getElementById("copy-link");
  const joinViewerBtn = document.getElementById("join-viewer");
  const tabTableBtn = document.getElementById("tab-table");
  const tabTasksBtn = document.getElementById("tab-tasks");
  const panelTable = document.getElementById("panel-table");
  const panelTasks = document.getElementById("panel-tasks");
  const historyEl = document.getElementById("history");
  const taskCount = document.getElementById("task-count");
  const clearHistoryBtn = document.getElementById("clear-history");

  const session = {
    name: "",
    room: "",
    playerId: "",
    state: null,
    source: null,
    version: -1,
    pingTimer: 0,
    historyJson: "",
    role: "player",
  };

  const savedName = localStorage.getItem("scrum-poker-name") || "";
  if (savedName) nameInput.value = savedName;

  const params = new URLSearchParams(location.search);
  roomInput.value = normalizeRoom(params.get("room") || makeRoom());
  history.replaceState(null, "", `?room=${encodeURIComponent(roomInput.value)}`);

  joinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      toast("Введите имя");
      return;
    }
    enterSession({ name, role: "player" });
  });
  joinViewerBtn.addEventListener("click", () => {
    enterSession({ name: "viewer", role: "viewer" });
  });

  revealBtn.addEventListener("click", () => post("/api/reveal"));
  resetBtn.addEventListener("click", () => post("/api/reset"));
  clearBtn.addEventListener("click", () => post("/api/clear"));
  clearHistoryBtn.addEventListener("click", () => post("/api/history-clear"));
  saveTaskBtn.addEventListener("click", saveTask);
  tabTableBtn.addEventListener("click", () => showTab("table"));
  tabTasksBtn.addEventListener("click", () => showTab("tasks"));
  taskInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveTask();
    }
  });
  copyLinkBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast("Ссылка скопирована");
    } catch {
      toast(location.href);
    }
  });

  deckEl.addEventListener("click", (event) => {
    const button = event.target.closest(".fib-card");
    if (!button || button.disabled) return;
    post("/api/vote", { value: button.dataset.value });
  });

  window.addEventListener("pagehide", () => {
    if (!session.playerId) return;
    navigator.sendBeacon(
      "/api/leave",
      new Blob([JSON.stringify({ room: session.room, playerId: session.playerId })], {
        type: "application/json",
      })
    );
  });

  async function enterSession({ name, role }) {
    const room = normalizeRoom(roomInput.value);
    try {
      const data = await api("/api/join", { name, room, role });
      session.name = role === "viewer" ? "viewer" : name;
      session.role = role;
      session.room = data.room;
      session.playerId = data.playerId;
      if (role !== "viewer") localStorage.setItem("scrum-poker-name", name);
      history.replaceState(null, "", `?room=${encodeURIComponent(session.room)}`);
      roomLabel.textContent = `комната ${session.room}`;
      youName.textContent = session.name;
      session.version = -1;
      session.historyJson = "";
      showTab("table");
      gate.classList.add("hidden");
      table.classList.remove("hidden");
      render(data);
      listen();
      startPing();
    } catch (error) {
      toast(error.message);
    }
  }

  function showTab(name) {
    const onTable = name === "table";
    tabTableBtn.classList.toggle("active", onTable);
    tabTasksBtn.classList.toggle("active", !onTable);
    tabTableBtn.setAttribute("aria-selected", String(onTable));
    tabTasksBtn.setAttribute("aria-selected", String(!onTable));
    panelTable.classList.toggle("hidden", !onTable);
    panelTasks.classList.toggle("hidden", onTable);
  }

  function leaveToGate(message) {
    if (!session.playerId) return;
    if (session.source) {
      session.source.close();
      session.source = null;
    }
    window.clearInterval(session.pingTimer);
    session.playerId = "";
    session.version = -1;
    session.state = null;
    session.historyJson = "";
    session.role = "player";
    table.classList.add("hidden");
    gate.classList.remove("hidden");
    showTab("table");
    const saved = localStorage.getItem("scrum-poker-name") || "";
    nameInput.value = saved;
    toast(message);
  }

  function listen() {
    if (session.source) session.source.close();
    const url = `/api/stream?room=${encodeURIComponent(session.room)}&playerId=${encodeURIComponent(session.playerId)}`;
    const source = new EventSource(url);
    session.source = source;
    source.onmessage = (event) => {
      try {
        render(JSON.parse(event.data));
      } catch {
        /* ignore malformed payloads */
      }
    };
    source.onerror = () => {
      source.close();
      window.setTimeout(() => {
        if (session.playerId) poll().finally(listen);
      }, 800);
    };
  }

  async function poll() {
    const query = new URLSearchParams({
      room: session.room,
      playerId: session.playerId,
    });
    const response = await fetch(`/api/state?${query}`);
    if (!response.ok) throw new Error("Не удалось обновить стол");
    render(await response.json());
  }

  function saveTask() {
    const title = taskInput.value.trim();
    if (!title) {
      toast("Введите название задачи");
      taskInput.focus();
      return;
    }
    post("/api/task", { task: title });
  }

  async function post(path, extra = {}) {
    try {
      const data = await api(path, {
        room: session.room,
        playerId: session.playerId,
        ...extra,
      });
      render(data);
    } catch (error) {
      toast(error.message);
    }
  }

  async function api(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Ошибка запроса");
    return data;
  }

  function startPing() {
    window.clearInterval(session.pingTimer);
    session.pingTimer = window.setInterval(() => {
      if (session.playerId) {
        fetch("/api/ping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room: session.room, playerId: session.playerId }),
        }).catch(() => {});
      }
    }, 8000);
  }

  function render(state) {
    if (session.playerId && state.present === false) {
      leaveToGate("Всех убрали из-за стола");
      return;
    }
    if (typeof state.version === "number") {
      if (state.version < session.version) return;
      session.version = state.version;
    }
    session.state = state;
    if (document.activeElement !== taskInput) {
      taskInput.value = state.task || "";
    }
    const ready = Boolean(state.task);
    const moderator = Boolean(state.moderator);
    session.role = moderator ? "viewer" : "player";
    storyEdit.classList.toggle("hidden", !moderator);
    if (ready) {
      taskTitle.textContent = state.task;
      taskTitle.classList.remove("hidden");
    } else {
      taskTitle.textContent = "";
      taskTitle.classList.add("hidden");
    }
    deckWrap.classList.toggle("hidden", !ready || moderator);
    taskHint.classList.toggle("hidden", ready);
    saveTaskBtn.classList.toggle("primary", !ready);
    saveTaskBtn.classList.toggle("ghost", ready);
    revealBtn.classList.toggle("hidden", !moderator);
    resetBtn.classList.toggle("hidden", !moderator);
    clearBtn.classList.toggle("hidden", !moderator);
    clearHistoryBtn.classList.toggle("hidden", !moderator);
    const voters = state.players.filter((player) => player.role !== "viewer");
    const voted = voters.filter((player) => player.hasVoted).length;
    voteCount.textContent = voters.length
      ? `${voted} из ${voters.length} оценили`
      : state.players.length
        ? "Наблюдатели за столом"
        : "Пока никого нет";
    seatsEl.innerHTML = state.players.map(seatHtml).join("");
    renderSummary(state);
    renderDeck(state);
    renderHistory(state);
    revealBtn.disabled = state.revealed;
    pickHint.textContent = state.revealed
      ? "Карты открыты. Нажмите «Новая задача», чтобы сбросить оценки."
      : "Карты Фибоначчи. Пока раунд открыт, оценку можно сменить.";
  }

  function seatHtml(player) {
    if (player.role === "viewer") {
      return `
        <article class="seat viewer${player.self ? " self" : ""}">
          <div class="avatar viewer-avatar">V</div>
          <div class="seat-name">viewer</div>
          <p class="seat-role">не голосует</p>
        </article>
      `;
    }
    const hue = hashHue(player.name);
    const initials = player.name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
    const revealed = Boolean(session.state?.revealed);
    const showFace = (revealed || player.self) && player.vote != null;
    let cardClass = "mini-card empty";
    let faceClass = "mini-face";
    let face = "";
    if (showFace) {
      cardClass = "mini-card face";
      if (player.vote === GRAVE_CARD) {
        faceClass += " triple";
        face = GRAVE_PARTS.map((part) => `<span>${part}</span>`).join("");
      } else if (player.vote === "☕") {
        faceClass += " emoji";
        face = "☕";
      } else {
        face = escapeHtml(player.vote);
      }
    } else if (player.hasVoted) {
      cardClass = "mini-card dealt";
    }
    return `
      <article class="seat${player.self ? " self" : ""}">
        <div class="avatar" style="background:hsl(${hue} 42% 38%)">${escapeHtml(initials)}</div>
        <div class="seat-name">${escapeHtml(player.name)}</div>
        <div class="${cardClass}">
          <div class="mini-inner">
            <div class="mini-back"></div>
            <div class="${faceClass}">${face}</div>
          </div>
        </div>
      </article>
    `;
  }

  function voteRank(vote, cards) {
    if (vote == null) return Number.POSITIVE_INFINITY;
    const index = cards.indexOf(vote);
    return index === -1 ? cards.length : index;
  }

  function voteCell(vote) {
    if (vote == null) return { html: "—", className: "vote empty" };
    if (vote === GRAVE_CARD) {
      return {
        html: GRAVE_PARTS.map((part) => `<span>${part}</span>`).join(""),
        className: "vote emoji",
      };
    }
    if (vote === "☕") return { html: "☕", className: "vote emoji" };
    return { html: escapeHtml(vote), className: "vote" };
  }

  function resultsTableHtml(rows, { highlightSelf = false } = {}) {
    const numbers = rows
      .map((player) => player.vote)
      .filter((vote) => vote != null && /^\d+$/.test(vote))
      .map((vote) => Number(vote));
    let note = "";
    if (numbers.length) {
      const min = Math.min(...numbers);
      const max = Math.max(...numbers);
      const avg = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
      note = min === max
        ? `Консенсус: ${min}`
        : `Среднее: ${formatNumber(avg)} · разброс ${min}–${max}`;
    }
    const body = rows
      .map((player) => {
        const cell = voteCell(player.vote);
        const selfClass = highlightSelf && player.self ? "self" : "";
        return `<tr class="${selfClass}">
          <td>${escapeHtml(player.name)}</td>
          <td class="${cell.className}">${cell.html}</td>
        </tr>`;
      })
      .join("");
    return `
      <table class="results">
        <thead>
          <tr>
            <th>Имя</th>
            <th>Оценка</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
      ${note ? `<p class="results-note">${note}</p>` : ""}
    `;
  }

  function sortedRows(players, cards) {
    return [...players].sort((left, right) => {
      const diff = voteRank(left.vote, cards) - voteRank(right.vote, cards);
      if (diff !== 0) return diff;
      return left.name.localeCompare(right.name, "ru");
    });
  }

  function renderSummary(state) {
    if (!state.revealed) {
      summaryEl.classList.add("hidden");
      summaryEl.innerHTML = "";
      return;
    }
    const cards = state.cards || CARDS;
    summaryEl.innerHTML = resultsTableHtml(
      sortedRows(state.players.filter((player) => player.role !== "viewer"), cards),
      { highlightSelf: true }
    );
    summaryEl.classList.remove("hidden");
  }

  function renderHistory(state) {
    const items = state.history || [];
    clearHistoryBtn.disabled = !items.length;
    const payload = JSON.stringify(items);
    if (payload === session.historyJson) return;
    session.historyJson = payload;
    if (items.length) {
      taskCount.hidden = false;
      taskCount.textContent = String(items.length);
    } else {
      taskCount.hidden = true;
      taskCount.textContent = "0";
    }
    if (!items.length) {
      historyEl.innerHTML = `<p class="muted">Пока нет сохранённых задач. Откройте карты — раунд появится здесь.</p>`;
      return;
    }
    const cards = state.cards || CARDS;
    historyEl.innerHTML = items
      .map((item, index) => {
        const title = item.title || "Без названия";
        const when = formatSavedAt(item.savedAt);
        const rows = sortedRows(item.votes || [], cards);
        return `
          <details class="history-item"${index === 0 ? " open" : ""}>
            <summary>
              <span>${escapeHtml(title)}</span>
              <span class="history-meta">${escapeHtml(when)}</span>
            </summary>
            ${resultsTableHtml(rows)}
          </details>
        `;
      })
      .join("");
  }

  function formatSavedAt(value) {
    const date = new Date(Number(value) * 1000);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("ru-RU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function renderDeck(state) {
    const me = state.players.find((player) => player.self);
    const selected = me?.vote;
    const cards = state.cards || CARDS;
    deckEl.innerHTML = cards.map((value) => {
      const classes = ["fib-card"];
      if (selected === value) classes.push("selected");
      const emoji = !/^\d+$/.test(value);
      if (emoji) classes.push("emoji");
      const triple = value === GRAVE_CARD;
      if (triple) classes.push("triple");
      const center = triple
        ? GRAVE_PARTS.map((part) => `<span>${part}</span>`).join("")
        : escapeHtml(value);
      const corners = emoji
        ? ""
        : `<span class="corner">${escapeHtml(value)}</span><span class="corner br">${escapeHtml(value)}</span>`;
      return `
        <button class="${classes.join(" ")}" data-value="${escapeHtml(value)}" ${state.revealed ? "disabled" : ""}>
          ${corners}
          <span class="center">${center}</span>
        </button>
      `;
    }).join("");
  }

  function normalizeRoom(value) {
    const cleaned = String(value || "")
      .trim()
      .replace(/[^\p{L}\p{N}_-]/gu, "")
      .slice(0, 16);
    return cleaned || "poker";
  }

  function makeRoom() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  }

  function hashHue(value) {
    let hash = 0;
    for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash % 360;
  }

  function formatNumber(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  let toastTimer = 0;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.remove("hidden");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.add("hidden"), 2200);
  }
})();
