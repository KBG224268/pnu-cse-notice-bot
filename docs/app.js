const STORAGE_KEYS = {
  saved: "pnu-cse-saved",
  read: "pnu-cse-read",
  theme: "pnu-cse-theme",
};

const state = {
  notices: [],
  filter: "all",
  sort: "latest",
  query: "",
  saved: new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.saved) || "[]")),
  read: new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.read) || "[]")),
};

const elements = {
  list: document.querySelector("#noticeList"),
  template: document.querySelector("#noticeTemplate"),
  empty: document.querySelector("#emptyState"),
  error: document.querySelector("#errorState"),
  search: document.querySelector("#searchInput"),
  clearSearch: document.querySelector("#clearSearchButton"),
  filters: [...document.querySelectorAll(".filter-button")],
  mobileFilters: [...document.querySelectorAll("[data-mobile-filter]")],
  mobileSearch: document.querySelector("#mobileSearchButton"),
  sort: document.querySelector("#sortSelect"),
  total: document.querySelector("#totalCount"),
  high: document.querySelector("#highCount"),
  unread: document.querySelector("#unreadCount"),
  deadline: document.querySelector("#deadlineCount"),
  resultSummary: document.querySelector("#resultSummary"),
  sync: document.querySelector("#syncStatus"),
  refresh: document.querySelector("#refreshButton"),
  install: document.querySelector("#installButton"),
  theme: document.querySelector("#themeButton"),
  retry: document.querySelector("#retryButton"),
  resetFilters: document.querySelector("#resetFiltersButton"),
  toast: document.querySelector("#toast"),
  spotlightCard: document.querySelector("#spotlightCard"),
  spotlightDeadline: document.querySelector("#spotlightDeadline"),
  spotlightCategory: document.querySelector("#spotlightCategory"),
  spotlightTitle: document.querySelector("#spotlightNoticeTitle"),
  spotlightSummary: document.querySelector("#spotlightSummary"),
  spotlightLink: document.querySelector("#spotlightLink"),
};

let toastTimer;
let deferredInstallPrompt;

function saveLocalState() {
  localStorage.setItem(STORAGE_KEYS.saved, JSON.stringify([...state.saved]));
  localStorage.setItem(STORAGE_KEYS.read, JSON.stringify([...state.read]));
}

function normalize(value) {
  return String(value || "").toLocaleLowerCase("ko-KR");
}

function parsePublishedDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value) {
  const parsed = parsePublishedDate(value);
  if (parsed) {
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(parsed);
  }
  return value ? String(value).replace(/\s+/g, " ").slice(0, 30) : "날짜 없음";
}

function extractDeadlineDate(value) {
  if (!value) return null;
  const text = String(value);
  const matches = [];
  const fullPattern = /(20\d{2})\s*(?:년|[.\/-])\s*(\d{1,2})\s*(?:월|[.\/-])\s*(\d{1,2})\s*(?:일|\.)?/g;
  const shortPattern = /(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
  let match;

  while ((match = fullPattern.exec(text)) !== null) {
    matches.push(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59));
  }
  while ((match = shortPattern.exec(text)) !== null) {
    const now = new Date();
    let candidate = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]), 23, 59, 59);
    if (candidate.getTime() < now.getTime() - 1000 * 60 * 60 * 24 * 180) {
      candidate = new Date(now.getFullYear() + 1, Number(match[1]) - 1, Number(match[2]), 23, 59, 59);
    }
    matches.push(candidate);
  }

  const valid = matches.filter((date) => !Number.isNaN(date.getTime()));
  return valid.length ? valid[valid.length - 1] : null;
}

function deadlineInfo(notice) {
  const date = extractDeadlineDate(notice.deadline);
  if (!date) return { date: null, label: "일정 확인", tone: "neutral", days: null };

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.ceil((target - today) / 86400000);

  if (days < 0) return { date, label: "마감 지남", tone: "expired", days };
  if (days === 0) return { date, label: "오늘 마감", tone: "urgent", days };
  if (days <= 3) return { date, label: `D-${days}`, tone: "urgent", days };
  if (days <= 7) return { date, label: `D-${days}`, tone: "soon", days };
  return { date, label: `D-${days}`, tone: "safe", days };
}

function inferCategory(notice) {
  const text = normalize([notice.title, notice.summary, notice.action].join(" "));
  const groups = [
    ["장학", ["장학", "지원금", "학자금"]],
    ["수업", ["수강", "강의", "시험", "성적", "분반", "휴강", "보강", "강의실"]],
    ["취업", ["취업", "채용", "인턴", "현장실습", "기업"]],
    ["행사", ["행사", "특강", "설명회", "경진대회", "공모전", "동아리", "모집"]],
    ["학사", ["학사", "휴학", "복학", "등록", "졸업", "학적"]],
  ];
  const found = groups.find(([, keywords]) => keywords.some((keyword) => text.includes(keyword)));
  return found ? found[0] : "일반";
}

function relevanceScore(value) {
  return { 높음: 3, 보통: 2, 낮음: 1 }[value] || 2;
}

function hasMeaningfulDeadline(notice) {
  const value = normalize(notice.deadline);
  return Boolean(value && !value.includes("명확한 일정 없음") && !value.includes("원문 확인"));
}

function filteredAndSortedNotices() {
  const query = normalize(state.query).trim();
  const filtered = state.notices.filter((notice) => {
    let filterMatch = true;
    if (state.filter === "높음") filterMatch = notice.relevance === "높음";
    if (state.filter === "deadline") filterMatch = hasMeaningfulDeadline(notice);
    if (state.filter === "saved") filterMatch = state.saved.has(notice.id);
    if (state.filter === "unread") filterMatch = !state.read.has(notice.id);

    const haystack = normalize([
      notice.title,
      notice.summary,
      notice.target,
      notice.action,
      notice.deadline,
      notice.reason,
      inferCategory(notice),
    ].join(" "));

    return filterMatch && (!query || haystack.includes(query));
  });

  return filtered.sort((a, b) => {
    if (state.sort === "priority") {
      return relevanceScore(b.relevance) - relevanceScore(a.relevance)
        || (parsePublishedDate(b.published_at)?.getTime() || 0) - (parsePublishedDate(a.published_at)?.getTime() || 0);
    }
    if (state.sort === "deadline") {
      const aInfo = deadlineInfo(a);
      const bInfo = deadlineInfo(b);
      const aTime = aInfo.date && aInfo.days >= 0 ? aInfo.date.getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = bInfo.date && bInfo.days >= 0 ? bInfo.date.getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime || relevanceScore(b.relevance) - relevanceScore(a.relevance);
    }
    return (parsePublishedDate(b.published_at)?.getTime() || 0) - (parsePublishedDate(a.published_at)?.getTime() || 0);
  });
}

function updateStats() {
  elements.total.textContent = state.notices.length;
  elements.high.textContent = state.notices.filter((notice) => notice.relevance === "높음").length;
  elements.unread.textContent = state.notices.filter((notice) => !state.read.has(notice.id)).length;
  elements.deadline.textContent = state.notices.filter(hasMeaningfulDeadline).length;
}

function selectSpotlight() {
  if (!state.notices.length) return null;
  const candidates = [...state.notices].sort((a, b) => {
    const aDeadline = deadlineInfo(a);
    const bDeadline = deadlineInfo(b);
    const aUrgency = aDeadline.days !== null && aDeadline.days >= 0 ? Math.max(0, 20 - aDeadline.days) : 0;
    const bUrgency = bDeadline.days !== null && bDeadline.days >= 0 ? Math.max(0, 20 - bDeadline.days) : 0;
    const aScore = relevanceScore(a.relevance) * 100 + aUrgency + (!state.read.has(a.id) ? 8 : 0);
    const bScore = relevanceScore(b.relevance) * 100 + bUrgency + (!state.read.has(b.id) ? 8 : 0);
    return bScore - aScore;
  });
  return candidates[0];
}

function updateSpotlight() {
  const notice = selectSpotlight();
  if (!notice) {
    elements.spotlightCategory.textContent = "공지 없음";
    elements.spotlightTitle.textContent = "아직 표시할 공지가 없어요.";
    elements.spotlightSummary.textContent = "GitHub Actions에서 웹앱 데이터를 한 번 생성해 주세요.";
    elements.spotlightDeadline.textContent = "대기 중";
    elements.spotlightDeadline.className = "deadline-pill neutral";
    elements.spotlightLink.href = "#noticeFeed";
    elements.spotlightLink.textContent = "설정 확인";
    return;
  }

  const info = deadlineInfo(notice);
  elements.spotlightCategory.textContent = `${inferCategory(notice)} · 관련도 ${notice.relevance || "보통"}`;
  elements.spotlightTitle.textContent = notice.title || "제목 없음";
  elements.spotlightSummary.textContent = notice.summary || notice.action || "원문에서 상세 내용을 확인하세요.";
  elements.spotlightDeadline.textContent = info.label;
  elements.spotlightDeadline.className = `deadline-pill ${info.tone}`;
  elements.spotlightLink.href = notice.link || "#noticeFeed";
  elements.spotlightLink.innerHTML = `원문 바로 보기 <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>`;
  elements.spotlightLink.target = "_blank";
  elements.spotlightLink.rel = "noopener noreferrer";
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  requestAnimationFrame(() => elements.toast.classList.add("show"));
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove("show");
    setTimeout(() => { elements.toast.hidden = true; }, 200);
  }, 1800);
}

function createCard(notice) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".notice-card");
  const saved = state.saved.has(notice.id);
  const isRead = state.read.has(notice.id);
  const category = inferCategory(notice);
  const deadline = deadlineInfo(notice);

  card.dataset.relevance = notice.relevance || "보통";
  card.classList.toggle("is-read", isRead);

  const categoryBadge = fragment.querySelector(".category-badge");
  categoryBadge.textContent = category;
  categoryBadge.dataset.category = category;
  fragment.querySelector(".relevance-badge").textContent = `관련도 ${notice.relevance || "보통"}`;
  fragment.querySelector(".published-date").textContent = formatDate(notice.published_at);
  fragment.querySelector(".notice-title").textContent = notice.title || "제목 없음";
  fragment.querySelector(".notice-summary").textContent = notice.summary || "요약을 만들지 못했습니다. 원문을 확인해 주세요.";
  fragment.querySelector(".notice-target").textContent = notice.target || "원문 확인 필요";
  fragment.querySelector(".notice-action").textContent = notice.action || "원문 확인 필요";
  fragment.querySelector(".notice-deadline").textContent = notice.deadline || "명확한 일정 없음";
  fragment.querySelector(".notice-reason").textContent = `판단 이유 · ${notice.reason || "안전하게 알림"}`;

  const deadlineBadge = fragment.querySelector(".card-deadline-badge");
  deadlineBadge.textContent = deadline.label;
  deadlineBadge.className = `card-deadline-badge ${deadline.tone}`;
  if (!hasMeaningfulDeadline(notice)) deadlineBadge.hidden = true;

  const link = fragment.querySelector(".original-link");
  link.href = notice.link;
  link.addEventListener("click", () => {
    state.read.add(notice.id);
    saveLocalState();
  });

  const saveButton = fragment.querySelector(".save-button");
  saveButton.classList.toggle("saved", saved);
  saveButton.setAttribute("aria-pressed", String(saved));
  saveButton.setAttribute("aria-label", saved ? "공지 저장 해제" : "공지 저장");
  saveButton.addEventListener("click", () => {
    if (state.saved.has(notice.id)) {
      state.saved.delete(notice.id);
      showToast("저장을 해제했어요.");
    } else {
      state.saved.add(notice.id);
      showToast("관심 공지로 저장했어요.");
    }
    saveLocalState();
    render();
  });

  const readButton = fragment.querySelector(".read-button");
  readButton.textContent = isRead ? "안 읽음으로" : "읽음 처리";
  readButton.addEventListener("click", () => {
    if (state.read.has(notice.id)) {
      state.read.delete(notice.id);
      showToast("안 읽은 공지로 되돌렸어요.");
    } else {
      state.read.add(notice.id);
      showToast("읽음 처리했어요.");
    }
    saveLocalState();
    render();
  });

  return fragment;
}

function filterLabel() {
  return { all: "전체", 높음: "중요", deadline: "마감 있음", saved: "저장", unread: "안 읽음" }[state.filter] || "전체";
}

function render() {
  elements.list.replaceChildren();
  elements.error.hidden = true;
  const notices = filteredAndSortedNotices();
  notices.forEach((notice) => elements.list.append(createCard(notice)));
  elements.empty.hidden = notices.length !== 0;
  elements.resultSummary.textContent = `${filterLabel()} 공지 ${notices.length}개${state.query ? ` · “${state.query}” 검색 결과` : ""}`;
  updateStats();
  updateSpotlight();
}

function syncFilterButtons() {
  elements.filters.forEach((button) => button.classList.toggle("active", button.dataset.filter === state.filter));
  elements.mobileFilters.forEach((button) => button.classList.toggle("active", button.dataset.mobileFilter === state.filter));
}

function setFilter(filter, { scroll = false } = {}) {
  state.filter = filter;
  syncFilterButtons();
  render();
  if (scroll) document.querySelector("#noticeFeed").scrollIntoView({ behavior: "smooth" });
}

function resetFilters() {
  state.query = "";
  state.sort = "latest";
  elements.search.value = "";
  elements.sort.value = "latest";
  elements.clearSearch.hidden = true;
  setFilter("all");
}

async function loadNotices({ manual = false } = {}) {
  elements.sync.textContent = manual ? "새 데이터 확인 중" : "데이터 불러오는 중";
  elements.error.hidden = true;
  elements.refresh.classList.toggle("is-loading", manual);
  elements.refresh.disabled = manual;

  try {
    const response = await fetch(`./notices.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("공지 데이터 형식 오류");
    state.notices = data;
    elements.sync.textContent = `공지 ${data.length}개 연결됨`;
    render();
    if (manual) showToast("최신 공지를 확인했어요.");
  } catch (error) {
    console.error(error);
    elements.list.replaceChildren();
    elements.empty.hidden = true;
    elements.error.hidden = false;
    elements.sync.textContent = "데이터 연결 확인 필요";
  } finally {
    elements.refresh.classList.remove("is-loading");
    elements.refresh.disabled = false;
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEYS.theme, theme);
  const isDark = theme === "dark" || (theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#0e1723" : "#0d3d73";
}

function initializeTheme() {
  applyTheme(localStorage.getItem(STORAGE_KEYS.theme) || "auto");
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const visuallyDark = current === "dark" || (current === "auto" && systemDark);
  applyTheme(visuallyDark ? "light" : "dark");
  showToast(visuallyDark ? "라이트 모드로 바꿨어요." : "다크 모드로 바꿨어요.");
}

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  elements.clearSearch.hidden = !state.query;
  render();
});
elements.clearSearch.addEventListener("click", () => {
  state.query = "";
  elements.search.value = "";
  elements.clearSearch.hidden = true;
  elements.search.focus();
  render();
});
elements.filters.forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.filter)));
elements.mobileFilters.forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.mobileFilter, { scroll: true })));
elements.mobileSearch.addEventListener("click", () => {
  document.querySelector("#noticeFeed").scrollIntoView({ behavior: "smooth" });
  setTimeout(() => elements.search.focus(), 450);
});
elements.sort.addEventListener("change", (event) => { state.sort = event.target.value; render(); });
elements.refresh.addEventListener("click", () => loadNotices({ manual: true }));
elements.retry.addEventListener("click", () => loadNotices({ manual: true }));
elements.resetFilters.addEventListener("click", resetFilters);
elements.theme.addEventListener("click", toggleTheme);

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
window.addEventListener("appinstalled", () => showToast("앱 설치가 완료됐어요."));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}

initializeTheme();
loadNotices();
