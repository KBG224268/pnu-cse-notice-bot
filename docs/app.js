const state = {
  notices: [],
  filter: "all",
  query: "",
  saved: new Set(JSON.parse(localStorage.getItem("pnu-cse-saved") || "[]")),
  read: new Set(JSON.parse(localStorage.getItem("pnu-cse-read") || "[]")),
};

const elements = {
  list: document.querySelector("#noticeList"),
  template: document.querySelector("#noticeTemplate"),
  empty: document.querySelector("#emptyState"),
  error: document.querySelector("#errorState"),
  search: document.querySelector("#searchInput"),
  filters: [...document.querySelectorAll(".filter-button")],
  total: document.querySelector("#totalCount"),
  high: document.querySelector("#highCount"),
  unread: document.querySelector("#unreadCount"),
  sync: document.querySelector("#syncStatus"),
  refresh: document.querySelector("#refreshButton"),
  install: document.querySelector("#installButton"),
};

function saveLocalState() {
  localStorage.setItem("pnu-cse-saved", JSON.stringify([...state.saved]));
  localStorage.setItem("pnu-cse-read", JSON.stringify([...state.read]));
}

function normalize(value) {
  return String(value || "").toLocaleLowerCase("ko-KR");
}

function formatDate(value) {
  if (!value) return "날짜 없음";
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(parsed);
  }
  return String(value).replace(/\s+/g, " ").slice(0, 30);
}

function filteredNotices() {
  const query = normalize(state.query).trim();
  return state.notices.filter((notice) => {
    const filterMatch = state.filter === "all"
      || notice.relevance === state.filter
      || (state.filter === "saved" && state.saved.has(notice.id));

    const haystack = normalize([
      notice.title,
      notice.summary,
      notice.target,
      notice.action,
      notice.deadline,
      notice.reason,
    ].join(" "));

    return filterMatch && (!query || haystack.includes(query));
  });
}

function updateStats() {
  elements.total.textContent = state.notices.length;
  elements.high.textContent = state.notices.filter((n) => n.relevance === "높음").length;
  elements.unread.textContent = state.notices.filter((n) => !state.read.has(n.id)).length;
}

function createCard(notice) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".notice-card");
  const saved = state.saved.has(notice.id);
  const isRead = state.read.has(notice.id);

  card.dataset.relevance = notice.relevance || "보통";
  card.classList.toggle("is-read", isRead);
  fragment.querySelector(".relevance-badge").textContent = `관련도 ${notice.relevance || "보통"}`;
  fragment.querySelector(".published-date").textContent = formatDate(notice.published_at);
  fragment.querySelector(".notice-title").textContent = notice.title || "제목 없음";
  fragment.querySelector(".notice-summary").textContent = notice.summary || "요약을 만들지 못했습니다.";
  fragment.querySelector(".notice-target").textContent = notice.target || "원문 확인 필요";
  fragment.querySelector(".notice-action").textContent = notice.action || "원문 확인 필요";
  fragment.querySelector(".notice-deadline").textContent = notice.deadline || "명확한 일정 없음";
  fragment.querySelector(".notice-reason").textContent = `판단 이유 · ${notice.reason || "안전하게 알림"}`;

  const link = fragment.querySelector(".original-link");
  link.href = notice.link;
  link.addEventListener("click", () => {
    state.read.add(notice.id);
    saveLocalState();
  });

  const saveButton = fragment.querySelector(".save-button");
  saveButton.classList.toggle("saved", saved);
  saveButton.setAttribute("aria-pressed", String(saved));
  saveButton.addEventListener("click", () => {
    if (state.saved.has(notice.id)) state.saved.delete(notice.id);
    else state.saved.add(notice.id);
    saveLocalState();
    render();
  });

  const readButton = fragment.querySelector(".read-button");
  readButton.textContent = isRead ? "안 읽음으로" : "읽음 처리";
  readButton.addEventListener("click", () => {
    if (state.read.has(notice.id)) state.read.delete(notice.id);
    else state.read.add(notice.id);
    saveLocalState();
    render();
  });

  return fragment;
}

function render() {
  elements.list.replaceChildren();
  elements.error.hidden = true;
  const notices = filteredNotices();

  notices.forEach((notice) => elements.list.append(createCard(notice)));
  elements.empty.hidden = notices.length !== 0;
  updateStats();
}

async function loadNotices({ manual = false } = {}) {
  elements.sync.textContent = manual ? "새 데이터를 확인하는 중…" : "공지 데이터를 불러오는 중…";
  elements.error.hidden = true;

  try {
    const response = await fetch(`./notices.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("공지 데이터 형식 오류");
    state.notices = data;
    elements.sync.textContent = `클라우드 자동 확인 중 · 공지 ${data.length}개`;
    render();
  } catch (error) {
    console.error(error);
    elements.list.replaceChildren();
    elements.empty.hidden = true;
    elements.error.hidden = false;
    elements.sync.textContent = "데이터 연결 확인 필요";
  }
}

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

elements.filters.forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    elements.filters.forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});

elements.refresh.addEventListener("click", () => loadNotices({ manual: true }));

let deferredInstallPrompt;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  elements.install.hidden = false;
});

elements.install.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  elements.install.hidden = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}

loadNotices();
