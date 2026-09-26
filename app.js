import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getDatabase, ref, set, update, remove, onValue, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

// ====== НАСТРОЙКИ (можно менять) ======
const CONFIG = {
  OWNER_EMAIL: "leritosha@gmail.com", // только этот Google-аккаунт получает права владельца (без имён дарителей — сюрприз)
  HELPER_EMAIL: "leritosha13@gmail.com", // видит, кто что дарит, но не может редактировать список
  // Отдельный Firebase-проект "wishlist" (console.firebase.google.com) — вход и хранение данных,
  // те же принципы, что и в leritonmap: вход через Google, доступ владельца по email,
  // правила Realtime Database ограничивают запись гостей только полем reservedBy.
  FIREBASE_CONFIG: {
    apiKey: "AIzaSyCWSp3MjlZPxAs6hrROmI83U-QxzKzej8w",
    authDomain: "wishlist-92432.firebaseapp.com",
    databaseURL: "https://wishlist-92432-default-rtdb.firebaseio.com",
    projectId: "wishlist-92432",
    storageBucket: "wishlist-92432.firebasestorage.app",
    messagingSenderId: "193096293416",
    appId: "1:193096293416:web:ff4618fb4556da8ba6e91d",
  },
  CONTACTS: [
    { name: "Антон", url: "https://t.me/eyeanton" },
    { name: "Лера", url: "https://t.me/egorova_leriya" },
  ],
};

// Для магазинов, из которых часто заказывают из РФ (платят в рублях), при вставке ссылки
// в форму нового подарка сами подставляем валюту и адрес ПВЗ в заметку — чтобы каждый раз
// не вписывать руками. Работает только пока цена/заметка ещё пустые, чтобы не затирать
// то, что уже ввели.
const LINK_PRESETS = [
  { test: /ozon\.(ru|com)\b/i, currency: "RUB", pickupNote: "ПВЗ Ozon: ул. Адонца, 4, Ереван" },
  { test: /wildberries\.(ru|by)\b|\bwb\.ru\b/i, currency: "RUB", pickupNote: "ПВЗ Wildberries: ул. Адонца, 17, Ереван" },
];

function matchLinkPreset(url){
  return LINK_PRESETS.find(p => p.test.test(url)) || null;
}

const LS = {
  theme: "wishlist_theme",
  viewCurrency: "wishlist_view_currency",
  rates: "wishlist_rates_cache",
  introSeen: "wishlist_intro_seen",
  dailyFactSeen: "wishlist_daily_fact_seen",
  factReadDate: "wishlist_fact_read_date",
  viewCounted: "wishlist_view_counted",
};

let IS_ADMIN = false;

const state = {
  items: [],
  isOwner: false,      // права на добавление/редактирование/удаление; статус брони не видит вообще (сюрприз)
  canSeeNames: false,  // хелпер (жена) — видит, кто что дарит, но не может менять список
  ownerEmail: null,
  loading: true,
  viewCurrency: localStorage.getItem(LS.viewCurrency) || "original", // "original" = цена в валюте, в которой её ввели, без конвертации
  sortBy: "price_asc", // "default" | "price_asc" | "price_desc" — по умолчанию сначала дешёвые
  selectedCategories: new Set(), // отмеченные категории в выпадающем списке; пусто = показать всё
  onlyMarketplace: false, // галочка "можно купить на Ozon/WB" в панели фильтров
};

// Какой из фильтров-дропдаунов (сортировка/категории/валюта) сейчас открыт — общий на все три,
// т.к. renderMain() каждый раз перестраивает всю панель фильтров заново и теряет атрибут open.
let openDropdownId = null;
document.addEventListener("click", e => {
  const open = document.querySelector(".dropdown-check[open]");
  if(open && !open.contains(e.target)){
    open.open = false;
    openDropdownId = null;
  }
});

const NO_CATEGORY = "Без категории";
const FIXED_CATEGORIES = ["Вайбкодинг", "Настолки", "Кофе", "Сертификаты", "Книги", "Одежда", "Хобби"];

function categoryOf(item){
  return (item.category && item.category.trim()) ? item.category.trim() : NO_CATEGORY;
}

function getAllCategories(){
  return Array.from(new Set(state.items.map(categoryOf))).sort((a, b) => a.localeCompare(b, "ru"));
}

// ====== УТИЛИТЫ ======
const $ = sel => document.querySelector(sel);

function escapeHtml(str){
  if(str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// Превращает голые ссылки в тексте заметки (например, "по ссылке - рубли\nhttps://...")
// в кликабельные <a>, остальной текст экранирует как обычно. Работает на СЫРОМ тексте (до
// экранирования) — split с ловящей группой возвращает [текст, ссылка, текст, ссылка, ...], чётные
// индексы экранируем как есть, нечётные — оборачиваем в ссылку (сам href тоже экранирован).
const URL_REGEX = /(https?:\/\/[^\s<>"]+)/g;
function linkifyText(str){
  if(str === null || str === undefined) return "";
  return String(str).split(URL_REGEX).map((part, i) => {
    if(i % 2 === 0) return escapeHtml(part);
    // Хвостовая пунктуация (точка/запятая/скобка и т.п.) после ссылки в прозе обычно не часть
    // самого URL — отрезаем её от ссылки, но оставляем в тексте.
    const trailingMatch = part.match(/[.,;:!?)\]'"]+$/);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const url = trailing ? part.slice(0, -trailing.length) : part;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>${escapeHtml(trailing)}`;
  }).join("");
}

const NOTE_COPY_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M4.5 13H3.8A1.8 1.8 0 0 1 2 11.2V3.8A1.8 1.8 0 0 1 3.8 2h7.4A1.8 1.8 0 0 1 13 3.8v.7"/></svg>`;

// Номер карты (12-19 цифр подряд) или адрес крипто-кошелька (длинный алфанумерик-токен) —
// оборачиваем в прямоугольник с кнопкой копирования (см. .note-copy-box в CSS). Ссылки — как и в
// linkifyText, кликабельным <a>. Всё остальное экранируется как обычно. Только для детальной
// модалки (openDetailModal) — в обрезанном превью карточки блочный элемент внутри
// -webkit-line-clamp мог бы визуально ломать подсчёт строк, поэтому там по-прежнему linkifyText.
const NOTE_TOKEN_REGEX = /(https?:\/\/[^\s<>"]+)|\b(\d[\d ]{10,18}\d)\b|\b([A-Za-z0-9_-]{20,})\b/g;
function renderNoteWithCopyBoxes(str){
  if(str === null || str === undefined) return "";
  const text = String(str);
  let html = "", lastIndex = 0, m;
  NOTE_TOKEN_REGEX.lastIndex = 0;
  while((m = NOTE_TOKEN_REGEX.exec(text))){
    html += escapeHtml(text.slice(lastIndex, m.index));
    if(m[1]){
      html += `<a href="${escapeHtml(m[1])}" target="_blank" rel="noopener">${escapeHtml(m[1])}</a>`;
    }else{
      const value = m[2] || m[3];
      html += `<span class="note-copy-box">${escapeHtml(value)}<button type="button" class="note-copy-btn" data-copy="${escapeHtml(value)}" title="Скопировать" aria-label="Скопировать">${NOTE_COPY_ICON}</button></span>`;
    }
    lastIndex = m.index + m[0].length;
  }
  html += escapeHtml(text.slice(lastIndex));
  return html;
}

// Ненавязчивый попап "Скопировано" — position:fixed без фона-подложки, клики/скролл сайта не
// блокирует. Ровно 1.5с на весь показ: 1с полностью видно, последние 0.5с — плавное угасание
// прозрачности (класс добавляется отдельным тиком, чтобы transition успел подхватить смену).
function showCopiedToast(){
  const el = document.createElement("div");
  el.className = "toast toast-copied";
  el.textContent = "Скопировано";
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-copied-fade");
    setTimeout(() => el.remove(), 500);
  }, 1000);
}

async function copyNoteValue(value){
  try{
    await navigator.clipboard.writeText(value);
    showCopiedToast();
  }catch(e){
    showToast("Не удалось скопировать", true);
  }
}

function uid(){
  return (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
}

function showToast(message, isError){
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ====== ТЕМА ======
function applyTheme(theme){
  if(theme === "light" || theme === "dark"){
    document.documentElement.setAttribute("data-theme", theme);
  }else{
    document.documentElement.removeAttribute("data-theme");
  }
  const btn = $("#themeToggle");
  if(btn){
    const isDark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    btn.setAttribute("aria-checked", isDark ? "true" : "false");
  }
}

// Вращение солнца/луны вокруг общего пивота (см. .sky-orbit в CSS) — spin только растёт, чтобы
// вращение всегда было по часовой стрелке, без исключений на повторных переключениях.
let skySpin = 0;

function initTheme(){
  const saved = localStorage.getItem(LS.theme);
  applyTheme(saved);
  // Солнце "дома" при --sky-spin:0 (см. dx/dy в разметке) — но если реально стартуем в тёмной
  // теме (сохранённой или системной), на загрузке дома должна быть луна. Выставляем поворот ДО
  // первой отрисовки: у элемента ещё нет предыдущего кадра, чтобы transition из style.css вообще
  // сработал, поэтому анимация тут не проигрывается — сразу нужное положение, без прыжка.
  const root = document.documentElement;
  const startIsDark = root.getAttribute("data-theme") === "dark"
    || (root.getAttribute("data-theme") !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if(startIsDark){
    skySpin = 180;
    $(".sky-orbit")?.style.setProperty("--sky-spin", skySpin);
  }
  const btn = $("#themeToggle");
  if(!btn) return;
  btn.addEventListener("click", () => {
    const root = document.documentElement;
    const current = root.getAttribute("data-theme")
      || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(LS.theme, next);
    // Один applyTheme() — дальше всё делают CSS-переходы: --bg1/--bg2/--night-opacity плавно
    // едут сами (см. :root в style.css), фон/карточки/текст читают их или синхронизированы той
    // же var(--sky-duration), а вращение солнца/луны ниже просто крутит .sky-orbit на 180°.
    // Никакого View Transitions API/круга от кнопки больше нет — раньше он был нужен, чтобы
    // спрятать мгновенную смену цвета под визуальный эффект, а теперь сама смена уже плавная и
    // синхронная с дугой, прятать нечего.
    applyTheme(next);
    // --sky-spin обновляем ВСЕГДА, даже при prefers-reduced-motion — иначе солнце/луна навсегда
    // застревают в положении по последнему повороту, а не по факту меняют тему (моргает только
    // цвет). Саму анимацию поворота отключает CSS (.sky-orbit/.sky-body-spin{transition:none}
    // под тем же media-query) — тут ничего дополнительно приглушать не нужно.
    skySpin += 180;
    $(".sky-orbit")?.style.setProperty("--sky-spin", skySpin);
  });
}

// ====== НЕБО (звёзды на тёмном фоне) ======
// Фон день/ночь сам по себе — на CSS-переменных --bg1/--bg2 и --night-opacity (реагируют на
// [data-theme] так же, как остальная тема). Тут только генерируем звёзды со случайным
// положением и длительностью/задержкой мерцания — чтобы они мигали вразнобой, а не все разом.
function initSky(){
  const container = $("#skyStars");
  if(!container || container.dataset.ready) return;
  container.dataset.ready = "1";
  const STAR_COUNT = 60;
  const frag = document.createDocumentFragment();
  for(let i = 0; i < STAR_COUNT; i++){
    const star = document.createElement("span");
    star.className = "sky-star";
    const size = (Math.random() * 1.6 + 1).toFixed(1);
    star.style.left = `${(Math.random() * 100).toFixed(2)}%`;
    star.style.top = `${(Math.random() * 70).toFixed(2)}%`;
    star.style.width = star.style.height = `${size}px`;
    star.style.animationDuration = `${(Math.random() * 2.5 + 2).toFixed(2)}s`;
    star.style.animationDelay = `${(Math.random() * -4).toFixed(2)}s`;
    frag.appendChild(star);
  }
  container.appendChild(frag);
}

// ====== ПАДАЮЩАЯ ЗВЕЗДА ======
// Раз в 5-9с (случайно) — только ночью (иначе звёзд не видно, и падающая звезда на светлом
// небе не имеет смысла); просто планируем следующую попытку и проверяем тему заново на каждом
// срабатывании, а не один раз при загрузке. Позиция — случайная точка в верхней трети неба; угол
// полёта — случайный, вниз-по-диагонали, чтобы траектория смотрелась естественно.
//
// Количество звёзд за один залп растёт вместе с счётчиком уникальных посетителей сайта
// (см. watchViewCount/maybeCountView ниже) — чем больше людей заглянуло, тем гуще звездопад.
// +1 звезда на каждые 10 посетителей, потолок 6 штук за раз (см. starsPerBurst).
let siteViewCount = 0;

function isNightSky(){
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--night-opacity")) > 0.5;
}

// opts позволяет переопределить положение/угол/цвет/длину полёта — используется пасхалкой клика
// по заголовку (см. handleTitleClick), обычный фоновый звездопад вызывает без аргументов и
// получает прежнее поведение через дефолты.
function spawnShootingStar(opts){
  opts = opts || {};
  const layer = $("#skyShooting");
  if(!layer) return;
  if(!opts.ignoreNight && !isNightSky()) return;
  const topPct = opts.top != null ? opts.top : Math.random() * 33;
  const leftPct = opts.left != null ? opts.left : Math.random() * 90;
  const angle = opts.angle != null ? opts.angle : 20 + Math.random() * 45;
  const wrap = document.createElement("div");
  wrap.className = "sky-shooting-star";
  wrap.style.top = `${topPct.toFixed(2)}%`;
  wrap.style.left = `${leftPct.toFixed(2)}%`;
  wrap.style.transform = `rotate(${angle.toFixed(1)}deg)`;
  const anim = document.createElement("div");
  anim.className = "sky-shooting-anim";
  if(opts.hue != null){
    anim.style.setProperty("--star-color", `hsl(${opts.hue},100%,70%)`);
    anim.style.setProperty("--star-glow1", `hsla(${opts.hue},100%,70%,.85)`);
    anim.style.setProperty("--star-glow2", `hsla(${opts.hue},100%,70%,.35)`);
    anim.style.setProperty("--star-tail", `hsla(${opts.hue},100%,70%,.85)`);
  }
  if(opts.dist != null) anim.style.setProperty("--star-dist", `${opts.dist.toFixed(0)}px`);
  anim.addEventListener("animationend", () => wrap.remove());
  wrap.appendChild(anim);
  layer.appendChild(wrap);
}

function starsPerBurst(){
  return Math.min(1 + Math.floor(siteViewCount / 10), 6);
}

function spawnShootingStarBurst(){
  const count = starsPerBurst();
  for(let i = 0; i < count; i++){
    setTimeout(spawnShootingStar, i * 150);
  }
}

// Таймер фонового звездопада — хранится, чтобы его можно было сбросить и начать 5-9с отсчёт
// заново (см. resetAmbientShootingStarTimer, вызывается из handleTitleClick): без этого клик по
// заголовку иногда совпадал с уже запланированным фоновым срабатыванием, и с неба падали две
// звезды одновременно вместо одной от клика.
let ambientShootingStarsEnabled = false;
let ambientShootingStarTimer = null;

function scheduleAmbientShootingStar(){
  if(!ambientShootingStarsEnabled) return;
  const delaySec = 5 + Math.random() * 4;
  ambientShootingStarTimer = setTimeout(() => { spawnShootingStarBurst(); scheduleAmbientShootingStar(); }, delaySec * 1000);
}

function resetAmbientShootingStarTimer(){
  if(!ambientShootingStarsEnabled) return;
  clearTimeout(ambientShootingStarTimer);
  scheduleAmbientShootingStar();
}

function initShootingStars(){
  if(window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  ambientShootingStarsEnabled = true;
  scheduleAmbientShootingStar();
}

// ====== ПАСХАЛКА: КЛИК ПО ЗАГОЛОВКУ ======
// "Вишлист" в шапке гостевой страницы раньше был ссылкой на admin.html — теперь владелец заходит
// туда напрямую по адресу, а заголовок стал маленькой пасхалкой (см. #titleClickTarget/#titleText
// в index.html). Обычный клик роняет одну звезду — намеренно в любое время суток (ignoreNight),
// иначе шутка не сработает днём — и одновременно подсвечивает очередную букву заголовка цветом
// радуги (в слове "Вишлист" ровно 7 букв — см. litNextTitleLetter). Когда подсвечены уже все 7 —
// вместо одной звезды срабатывает цветной звездопад (см. spawnTitleStarBurst) и новая звезда
// остаётся в небе навсегда, для всех гостей (см. addBonusStar/watchBonusStars). После этого
// заголовок необратимо блокируется до конца сессии (см. titleEasterEggLocked) — текст остаётся
// радужным, повторно пасхалку не запустить, пока страница не перезагрузится.
const TITLE_RAINBOW_COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#5e5ce6", "#af52de"];
let titleLetterIndex = 0;
let titleEasterEggLocked = false;

// Разбивает текст заголовка на отдельные span'ы по буквам — один раз при старте, до этого клики
// подсвечивать нечего. Само экранирование не нужно: буквы кириллицы/латиницы не содержат
// спецсимволов HTML, а textContent уже отдал их в чистом виде.
function initTitleLetters(){
  const el = $("#titleText");
  if(!el || el.dataset.split) return;
  el.dataset.split = "1";
  el.innerHTML = Array.from(el.textContent).map(ch => `<span class="title-letter">${ch}</span>`).join("");
}

function litNextTitleLetter(){
  const letters = document.querySelectorAll("#titleText .title-letter");
  if(titleLetterIndex >= letters.length) return;
  const el = letters[titleLetterIndex];
  const color = TITLE_RAINBOW_COLORS[titleLetterIndex % TITLE_RAINBOW_COLORS.length];
  // transition — только тут, точечно на конкретной букве, в момент её единственного и
  // необратимого перехода от "наследует var(--text)" к фиксированному цвету радуги. НЕ через
  // общее CSS-правило на .title-letter — иначе оно цепляло бы и ещё непогашенные буквы, чей цвет
  // всё ещё пассивно едет вместе с темой (var(--text) уже анимируется на :root — см. начало
  // файла), и получился бы тот самый двойной переход.
  el.style.transition = "color .3s ease, text-shadow .3s ease";
  el.style.color = color;
  el.style.textShadow = `0 0 6px ${color}, 0 0 14px ${color}`;
  titleLetterIndex++;
}

function spawnTitleStarBurst(){
  for(let i = 0; i < 9; i++){
    setTimeout(() => {
      spawnShootingStar({
        top: Math.random() * 5,
        left: 35 + Math.random() * 30,
        // 15-165° — вниз-вправо через строго вниз до вниз-влево, никогда вверх (0°/180° —
        // строго вбок, тоже исключены с запасом).
        angle: 15 + Math.random() * 150,
        dist: 150 + Math.random() * 170,
        hue: Math.floor(Math.random() * 360),
        ignoreNight: true,
      });
    }, i * 200);
  }
  setTimeout(addBonusStar, 9 * 200 + 300);
}

// "Особый режим": с 9-го клика (звездопад + зажигание + попап называния) и до тех пор, пока
// попап не закрыт (назвали звезду или погасили) — карточки товаров и календарь плавно уходят в
// прозрачность, чтобы ничего не отвлекало от неба. Заодно на это время показываем подписи уже
// существующих именованных звёзд (см. .sky-star-name-label в style.css) — это "витрина" только
// для владельца текущего клика, у остальных гостей просто тихо появляется звезда (см.
// watchBonusStars) без всего этого режима.
function enterStarSpecialMode(){
  document.body.classList.add("star-mode-dim");
  bonusStarsData.forEach(({ data }) => {
    if(!data.name) return;
    const label = document.createElement("span");
    label.className = "sky-star-name-label";
    label.textContent = data.name;
    label.style.left = `${data.left}%`;
    label.style.top = `${data.top}%`;
    label.style.color = `hsl(${data.hue},100%,70%)`;
    label.dataset.tempLabel = "1";
    $("#skyStars")?.appendChild(label);
  });
}

function exitStarSpecialMode(){
  document.body.classList.remove("star-mode-dim");
  document.querySelectorAll('.sky-star-name-label[data-temp-label="1"]').forEach(el => el.remove());
}

function handleTitleClick(){
  if(titleEasterEggLocked) return;
  litNextTitleLetter();
  if(titleLetterIndex >= TITLE_RAINBOW_COLORS.length){
    // Необратимо: назад к titleLetterIndex=0 сознательно не откатываем, даже если погасят
    // звезду — пасхалка одноразовая на сессию, а не циклический счётчик.
    titleEasterEggLocked = true;
    enterStarSpecialMode();
    spawnTitleStarBurst();
  }else{
    spawnShootingStar({ top: Math.random() * 5, left: 40 + Math.random() * 20, angle: 20 + Math.random() * 45, ignoreNight: true });
  }
  // Клик уронил звезду прямо сейчас — сдвигаем следующий фоновый звездопад на новые 5-9с,
  // иначе он может выстрелить почти тут же следом и создать впечатление, что упало сразу две.
  resetAmbientShootingStarTimer();
}

// Расходящаяся окружность того же цвета в момент зажигания звезды — растёт от точки до
// половины экрана по радиусу (100vmax в диаметре) и одновременно теряет непрозрачность,
// исчезая полностью к концу. Только для ЗАЖИГАНИЯ, не для самой звезды — см. вызовы ниже.
function spawnStarRipple(data){
  const layer = $("#skyStars");
  if(!layer) return;
  const ripple = document.createElement("span");
  ripple.className = "sky-star-ripple";
  ripple.style.left = `${data.left}%`;
  ripple.style.top = `${data.top}%`;
  ripple.style.setProperty("--ripple-color", `hsl(${data.hue},100%,70%)`);
  ripple.addEventListener("animationend", () => ripple.remove());
  layer.appendChild(ripple);
}

// Звезда-пасхалка рисуется в общий #skyStars (мерцающий фон), но без постоянного твинкла — см.
// .sky-star-bonus в style.css: цвет и непрозрачность у неё уже сами по себе случайные и
// постоянные, обычный бесконечный twinkle их бы просто перекрыл. Вместо этого — конечный
// пульс яркости именно в момент появления (см. isNewAppearance/.sky-star-bonus-pulse), после
// которого звезда успокаивается на своей обычной непрозрачности.
// data приходит либо только что сгенерированной (у того, кто добил 9-й клик), либо из Firebase
// (у всех остальных, см. watchBonusStars) — форма одна и та же. isNewAppearance — только для
// по-настоящему НОВОГО появления, не для загрузки уже существующих звёзд при открытии страницы
// (иначе на каждый заход запульсировало бы разом столько звёзд, сколько уже накопилось).
// Возвращает сам DOM-элемент звезды — нужен, чтобы его можно было убрать при "погасить" (см.
// openStarNamePopup).
function renderBonusStar(data, isNewAppearance){
  const layer = $("#skyStars");
  if(!layer) return null;
  const star = document.createElement("span");
  star.className = "sky-star sky-star-bonus" + (isNewAppearance ? " sky-star-bonus-pulse" : "");
  const size = (Math.random() * 1.6 + 1.4).toFixed(1);
  star.style.left = `${data.left}%`;
  star.style.top = `${data.top}%`;
  star.style.width = star.style.height = `${size}px`;
  star.style.background = `hsl(${data.hue},100%,70%)`;
  star.style.opacity = data.opacity;
  star.style.setProperty("--star-base-opacity", data.opacity);
  star.style.boxShadow = `0 0 6px 2px hsla(${data.hue},100%,70%,.55)`;
  layer.appendChild(star);
  return star;
}

// key -> { data, starEl } для ВСЕХ известных звёзд (своих и чужих) — нужно, чтобы во время
// enterStarSpecialMode() показать подписи уже названных звёзд, и чтобы "погасить" могло найти и
// убрать DOM-элемент конкретной звезды. Ключ генерируем сами (не push()) и сразу отмечаем как
// известный — иначе собственный же watchBonusStars(), получив это значение обратно из Firebase,
// отрисует его второй раз поверх. Требует отдельного правила в Firebase Security Rules на запись
// в sky/bonusStars — как и stats/viewCount (см. maybeCountView), без правила просто тихо не
// сохранится: инициатор всё равно видит звезду локально, остальные — только после того, как
// правило добавят.
let bonusStarsData = new Map();

const STAR_NAME_SUGGESTIONS = ["Вега", "Регул", "Спика", "Ригель", "Альтаир", "Полярная", "Денеб", "Антарес"];
const STAR_NAME_CONFIRM_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 10.5 8 14.5 16 5.5"/></svg>`;

// Попап называния — НЕ через общий openModal (тот всегда по центру экрана целиком), а отдельным
// оверлеем: всегда по горизонтали в центре, а по вертикали — над звездой или под ней (если звезда
// в нижней половине экрана, попап сверху, и наоборот), чтобы никогда не перекрывать саму звезду.
// Плюс пунктирная линия-коннектор к звезде, бегущая к ней (см. .star-name-connector-dash в
// style.css). Показывается только инициатору 9-го клика — остальные гости просто видят готовую
// звезду через watchBonusStars, без этого попапа и без затемнения.
function openStarNamePopup(key, data, starEl){
  const sx = (data.left / 100) * window.innerWidth;
  const sy = (data.top / 100) * window.innerHeight;
  const suggested = STAR_NAME_SUGGESTIONS[Math.floor(Math.random() * STAR_NAME_SUGGESTIONS.length)];

  const overlay = document.createElement("div");
  overlay.className = "star-name-overlay";
  overlay.innerHTML = `
    <svg class="star-name-connector"><line class="star-name-connector-dash"/></svg>
    <div class="star-name-popup">
      <p>Вы только что зажгли звезду, она будет светить всем!<br>Как вы назовёте эту звезду?</p>
      <div class="star-name-input-wrap">
        <input type="text" id="starNameInput" placeholder="${escapeHtml(suggested)}">
        <button type="button" id="starNameSaveBtn" aria-label="Назвать" title="Назвать">${STAR_NAME_CONFIRM_ICON}</button>
      </div>
      <button type="button" id="starExtinguishBtn" class="star-extinguish-link">Погасить звезду</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const popup = overlay.querySelector(".star-name-popup");
  const line = overlay.querySelector("line");
  const margin = 16;
  const gap = 40; // зазор между попапом и самой звездой (плюс её свечение), чтобы не перекрывать
  const popupRect = popup.getBoundingClientRect();

  let popupLeft = (window.innerWidth - popupRect.width) / 2;
  popupLeft = Math.max(margin, Math.min(popupLeft, window.innerWidth - popupRect.width - margin));

  const starInBottomHalf = sy > window.innerHeight / 2;
  let popupTop = starInBottomHalf ? sy - gap - popupRect.height : sy + gap;
  popupTop = Math.max(margin, Math.min(popupTop, window.innerHeight - popupRect.height - margin));

  popup.style.left = `${popupLeft}px`;
  popup.style.top = `${popupTop}px`;

  const px = popupLeft + popupRect.width / 2;
  const py = starInBottomHalf ? popupTop + popupRect.height : popupTop;
  line.setAttribute("x1", sx); line.setAttribute("y1", sy);
  line.setAttribute("x2", px); line.setAttribute("y2", py);
  line.setAttribute("stroke", `hsla(${data.hue},100%,70%,.3)`);

  const nameInput = overlay.querySelector("#starNameInput");
  const confirmBtn = overlay.querySelector("#starNameSaveBtn");
  nameInput.focus();
  // Галочка "пустая" (см. .star-name-input-wrap button в style.css), пока в поле ничего не
  // введено — заполняется цветом только когда там реально есть текст, как кнопка отправки в
  // мессенджерах.
  nameInput.addEventListener("input", () => {
    confirmBtn.classList.toggle("is-filled", nameInput.value.trim().length > 0);
  });

  function closeOverlay(){
    overlay.remove();
    exitStarSpecialMode();
  }
  function confirmName(){
    const val = overlay.querySelector("#starNameInput").value.trim() || suggested;
    data.name = val;
    // Расходящийся круг — теперь именно тут, в момент называния, а не при появлении самой точки
    // (см. addBonusStar).
    spawnStarRipple(data);
    if(db) update(ref(db, "sky/bonusStars/" + key), { name: val }).catch(() => { /* нет доступа — правило ещё не добавлено */ });
    closeOverlay();
  }
  overlay.querySelector("#starNameSaveBtn").addEventListener("click", confirmName);
  overlay.querySelector("#starNameInput").addEventListener("keydown", e => {
    if(e.key === "Enter") confirmName();
  });
  overlay.querySelector("#starExtinguishBtn").addEventListener("click", () => {
    bonusStarsData.delete(key);
    starEl?.remove();
    if(db) remove(ref(db, "sky/bonusStars/" + key)).catch(() => { /* нет доступа — правило ещё не добавлено */ });
    closeOverlay();
  });
}

function addBonusStar(){
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data = {
    hue: Math.floor(Math.random() * 360),
    opacity: Number((0.8 + Math.random() * 0.2).toFixed(2)),
    left: Number((Math.random() * 100).toFixed(2)),
    // Только верхняя треть экрана — ниже звезду вместе с попапом называния перекрывает
    // мобильная клавиатура, пока вводишь имя.
    top: Number((Math.random() * 33).toFixed(2)),
    name: null,
  };
  // isNewAppearance:true — пульс яркости играет тут, при появлении самой точки. Ripple (круг) —
  // отдельно, ПОСЛЕ того как звезду назвали (см. openStarNamePopup), не в этот момент.
  const starEl = renderBonusStar(data, true);
  bonusStarsData.set(key, { data, starEl });
  openStarNamePopup(key, data, starEl);
  if(!db) return;
  set(ref(db, "sky/bonusStars/" + key), data).catch(() => { /* нет доступа — правило ещё не добавлено */ });
}

// Первый снапшот onValue отдаёт ВСЕ уже существующие звёзды разом — их рисуем тихо, без пульса и
// без ripple (иначе при каждом заходе на сайт разом запульсировало и вспыхнуло бы столько звёзд,
// сколько накопилось за всё время). Пульс и ripple — только для действительно новых ключей,
// появившихся ПОСЛЕ первого снапшота (то есть кто-то ещё, в реальном времени, только что добил
// свой 9-й клик) — у них просто зажигается звезда с пульсом и кругом, без затемнения экрана и без
// попапа (это только у инициатора, см. addBonusStar).
let bonusStarsInitialLoadDone = false;

function watchBonusStars(){
  if(!db) return;
  onValue(ref(db, "sky/bonusStars"), snap => {
    const val = snap.val() || {};
    const isLiveUpdate = bonusStarsInitialLoadDone;
    Object.keys(val).forEach(key => {
      if(bonusStarsData.has(key)) return;
      const data = val[key];
      const starEl = renderBonusStar(data, isLiveUpdate);
      bonusStarsData.set(key, { data, starEl });
      if(isLiveUpdate) spawnStarRipple(data);
    });
    bonusStarsInitialLoadDone = true;
  }, () => { /* нет доступа (правило ещё не добавлено) — просто не подгружаем чужие звёзды */ });
}

// ====== СЧЁТЧИК ДО 1 ОКТЯБРЯ ======
function daysWord(n){
  const mod10 = n % 10, mod100 = n % 100;
  if(mod100 >= 11 && mod100 <= 14) return "дней";
  if(mod10 === 1) return "день";
  if(mod10 >= 2 && mod10 <= 4) return "дня";
  return "дней";
}

const DOW_SHORT = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
const MONTH_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const DAY_MS = 1000 * 60 * 60 * 24;

// Точка отсчёта календарика зафиксирована (не "сегодня минус N") — так уже открытые клетки
// не съезжают и не пересчитываются, а просто остаются на месте и помечаются прошедшими.
const CALENDAR_START = new Date(2026, 8, 22);

// Факт про Антона на каждый день — открывается в свой день (ключ "YYYY-MM-DD"), доступен по
// клику на уже прошедшую (оторванную) клетку. Реальные факты редактируются владельцем прямо на
// сайте (см. openFactEditModal) и хранятся в Firebase — этот объект лишь подстраховка на случай,
// если в базе для сегодняшнего дня ещё пусто.
// Значение — HTML (владелец форматирует текст жирностью/выравниванием через редактор).
const DEFAULT_DAILY_FACTS = {
  "2026-09-22":
    "<p>За 2026 год потратил на настолки 370$ и играл более 120 часов 🎲</p>" +
    "<p>Возможно, всё началось с лото. Когда собирались всей семьёй у бабушки в гостях — мы доставали деревянные бочонки, а бабушка с особым азартом выкрикивала номера со всякими приговорками: «11 — барабанные палочки». А сегодняшняя дата звучала бы так: «22 — утята!»</p>" +
    "<p>Так что для меня настолки с детства — это возможность привнести в жизнь счастье, весёлое общение и светлую атмосферу. Нужны лишь простые картонки и хорошие люди рядом.</p>",
};
let DAILY_FACTS = { ...DEFAULT_DAILY_FACTS };

function dateKey(d){
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getBirthdayTarget(today){
  let target = new Date(today.getFullYear(), 9, 1); // месяцы с 0 — 9 это октябрь
  if(target < today) target = new Date(today.getFullYear() + 1, 9, 1);
  return target;
}

function renderCountdown(){
  const el = $("#countdown");
  if(!el) return;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = getBirthdayTarget(today);
  const daysLeft = Math.round((target - today) / DAY_MS);
  const label = daysLeft <= 0 ? "Сегодня 1 октября! 🎉" : `До ДР Антона ${daysLeft} ${daysWord(daysLeft)}!`;

  // По клеточке на каждый день от фиксированного старта до 1 октября — ряд не сжимается со
  // временем. У последней клетки (день Х) число остаётся на месте (иначе неясно, что это именно
  // 1 октября), а праздничный эмодзи ложится полупрозрачным фоном под цифрой. Сегодняшняя клетка
  // обведена оранжевым (см. .calendar-cell-today) — раньше рамка была у 1 октября, но это далёкая
  // будущая дата, а обводить хотелось именно "где мы сейчас". Прошедшие клетки, и сегодняшняя ПОСЛЕ
  // прочтения факта (см. openFactModal — отмечает LS.factReadDate), выглядят слегка оторванными:
  // наклон + чем клетка старше, тем сильнее блёкнет (см. --cell-opacity ниже). Сегодняшняя, пока
  // факт не открыт, стоит ровно и в полную силу — это и есть "непрочитано". Кликабельны клетки, для
  // которых есть факт (включая сегодняшнюю, до или после прочтения). Владельцу (после входа)
  // кликабельны вообще все клетки, включая будущие без текста, — так он может писать факты заранее.
  const canEditFacts = IS_ADMIN && state.isOwner;
  const totalDays = Math.round((target - CALENDAR_START) / DAY_MS) + 1;
  const daysSinceStart = Math.round((today - CALENDAR_START) / DAY_MS);
  const todayFactRead = localStorage.getItem(LS.factReadDate) === dateKey(today);
  // Градиент затухания прошедших дней: чем дальше в прошлом, тем прозрачнее. Позавчера и раньше —
  // от 5% (самый старый) до 40%, равномерно. Вчера — отдельно, 45% (на ступеньку выше этого
  // диапазона). Сегодня — не по этой шкале: 100% пока факт не открыт, 50% сразу после прочтения.
  const olderCount = Math.max(daysSinceStart - 1, 0);
  function pastOpacity(i){
    if(i === daysSinceStart - 1) return 0.45; // вчера
    if(olderCount <= 1) return 0.05;
    return 0.05 + (i / (olderCount - 1)) * 0.35;
  }
  const cells = Array.from({ length: Math.max(totalDays, 0) }, (_, i) => {
    const d = new Date(CALENDAR_START.getTime() + i * DAY_MS);
    const isTarget = d.getTime() === target.getTime();
    const isToday = d.getTime() === today.getTime();
    const isPastStrict = d.getTime() < today.getTime();
    const canView = d.getTime() <= today.getTime();
    const key = dateKey(d);
    const clickable = canEditFacts || (canView && DAILY_FACTS[key]);
    const tilted = isPastStrict || (isToday && todayFactRead);
    const dayContent = isTarget
      ? `<span class="calendar-cell-confetti">🎉</span><span class="calendar-cell-daynum">${d.getDate()}</span>`
      : d.getDate();
    const classes = ["calendar-cell", isTarget && "calendar-cell-target", isToday && "calendar-cell-today", tilted && "calendar-cell-past"].filter(Boolean).join(" ");
    const opacity = isToday ? (todayFactRead ? 0.5 : 1) : (isPastStrict ? pastOpacity(i) : null);
    const style = opacity !== null ? ` style="--cell-opacity:${opacity}"` : "";
    return `
      <div class="${classes}"${clickable ? ` data-fact-date="${key}"` : ""}${style}>
        <div class="calendar-cell-dow">${isTarget ? MONTH_SHORT[d.getMonth()] : DOW_SHORT[d.getDay()]}</div>
        <div class="calendar-cell-day">${dayContent}</div>
      </div>
    `;
  }).join("");

  el.innerHTML = `
    <div class="calendar-row">${cells}<div class="countdown-label">${label}</div></div>
  `;

  el.querySelectorAll(".calendar-cell[data-fact-date]").forEach(cell => {
    cell.addEventListener("click", () => {
      if(canEditFacts) openFactEditModal(cell.dataset.factDate);
      else openFactModal(cell.dataset.factDate);
    });
  });
}

// Простой попап с фактом про Антона на конкретный день. Дата показана тем же
// календариком-клеткой, что и в самом счётчике — для узнаваемости. Текст — уже готовый HTML
// (форматирование задаёт владелец в редакторе), поэтому вставляем как есть, без экранирования.
function openFactModal(key){
  const html = DAILY_FACTS[key];
  if(!html) return;
  // Открытие факта СЕГОДНЯШНЕГО дня — это и есть "прочитано": клетка перестаёт стоять ровно и
  // в полную силу, наклоняется и блёкнет до 50%, как и остальные прошедшие (см. renderCountdown).
  const now = new Date();
  const todayKey = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  if(key === todayKey && localStorage.getItem(LS.factReadDate) !== todayKey){
    localStorage.setItem(LS.factReadDate, todayKey);
    renderCountdown();
  }
  const [y, m, d] = key.split("-").map(Number);
  openModal(`
    <div class="fact-popup-header">
      <div class="calendar-cell">
        <div class="calendar-cell-dow">${MONTH_SHORT[m - 1]}</div>
        <div class="calendar-cell-day">${d}</div>
      </div>
      <div class="fact-popup-title">Сегодняшний факт про меня:</div>
    </div>
    <div class="fact-popup-body">${html}</div>
    <div class="modal-actions modal-actions-center">
      <button id="factCloseBtn">Понятно!</button>
    </div>
  `, overlay => {
    overlay.querySelector("#factCloseBtn").addEventListener("click", closeModal);
  }, { closeOnBackdrop: true });
}

// Админка "на коленке": владелец кликает по любой клетке (не только прошедшей) и сразу видит и
// правит текст факта — без обращения к разработчику. Редактор — contenteditable вместо textarea,
// чтобы можно было выделить текст и применить жирность/выравнивание через всплывающее мини-меню
// (см. .rt-toolbar ниже), а не только вводить голый текст.
function openFactEditModal(key){
  const html = DAILY_FACTS[key] || "";
  const [y, m, d] = key.split("-").map(Number);
  openModal(`
    <div class="fact-popup-header">
      <div class="calendar-cell">
        <div class="calendar-cell-dow">${MONTH_SHORT[m - 1]}</div>
        <div class="calendar-cell-day">${d}</div>
      </div>
      <div class="fact-popup-title">Факт на этот день</div>
    </div>
    <div class="field">
      <label>Текст</label>
      <div id="factText" class="field-richtext" contenteditable="true">${html || "<p><br></p>"}</div>
      <small>Выделите текст — появится мини-меню с жирностью и выравниванием.</small>
    </div>
    <div class="error-text" id="factEditError"></div>
    <div class="modal-actions">
      ${html ? '<button class="danger left" id="factDeleteBtn">Удалить</button>' : ""}
      <button class="secondary" id="factCancelBtn">Отмена</button>
      <button id="factSaveBtn">Сохранить</button>
    </div>
  `, overlay => {
    const editor = overlay.querySelector("#factText");
    try{ document.execCommand("defaultParagraphSeparator", false, "p"); }catch(e){ /* старые браузеры просто продолжат с div */ }
    editor.focus();

    // Мини-меню жирности/выравнивания над выделением. Кнопки ловят mousedown с preventDefault,
    // иначе клик по кнопке сначала снимает выделение в редакторе (фокус уходит на кнопку) — и
    // execCommand применяется уже не к тому, что выделяли.
    let toolbar = null;
    const removeToolbar = () => { toolbar?.remove(); toolbar = null; };
    const updateToolbar = () => {
      if(!document.body.contains(editor)){
        document.removeEventListener("selectionchange", updateToolbar);
        removeToolbar();
        return;
      }
      const sel = window.getSelection();
      if(!sel || sel.isCollapsed || sel.rangeCount === 0 || !editor.contains(sel.anchorNode)){
        removeToolbar();
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if(!toolbar){
        toolbar = document.createElement("div");
        toolbar.className = "rt-toolbar";
        toolbar.innerHTML = `
          <button type="button" data-cmd="bold" title="Жирный"><b>Ж</b></button>
          <button type="button" data-cmd="justifyLeft" title="По левому краю">⟸</button>
          <button type="button" data-cmd="justifyCenter" title="По центру">⟺</button>
          <button type="button" data-cmd="justifyRight" title="По правому краю">⟹</button>
        `;
        overlay.appendChild(toolbar);
        toolbar.querySelectorAll("button").forEach(btn => {
          btn.addEventListener("mousedown", e => e.preventDefault());
          btn.addEventListener("click", () => {
            document.execCommand(btn.dataset.cmd);
            updateToolbar();
          });
        });
      }
      toolbar.style.left = Math.round(rect.left + rect.width / 2 - toolbar.offsetWidth / 2) + "px";
      toolbar.style.top = Math.round(rect.top - toolbar.offsetHeight - 8) + "px";
    };
    document.addEventListener("selectionchange", updateToolbar);

    overlay.querySelector("#factCancelBtn").addEventListener("click", closeModal);
    overlay.querySelector("#factDeleteBtn")?.addEventListener("click", async () => {
      if(!confirm("Удалить факт на этот день?")) return;
      await withLoadingButton(overlay.querySelector("#factDeleteBtn"), async () => {
        await remove(factRef(key));
        closeModal();
        showToast("Факт удалён");
      });
    });
    overlay.querySelector("#factSaveBtn").addEventListener("click", async () => {
      if(!editor.textContent.trim()){
        overlay.querySelector("#factEditError").textContent = "Введите текст факта";
        return;
      }
      await withLoadingButton(overlay.querySelector("#factSaveBtn"), async () => {
        await set(factRef(key), editor.innerHTML.trim());
        closeModal();
        showToast("Факт сохранён");
      });
    });
  }, { closeOnBackdrop: true });
}

// Клетка нового факта слегка покачивается и показывает короткую подсказку над собой — вместо
// того чтобы сразу открывать попап (это уже интрузивно на каждый день), просто привлекаем
// внимание, а сам факт гость открывает кликом, как и все остальные прошедшие дни.
function highlightNewFactCell(key){
  const cell = document.querySelector(`.calendar-cell[data-fact-date="${key}"]`);
  if(!cell) return;
  cell.classList.add("calendar-cell-new-fact");
  cell.addEventListener("animationend", () => cell.classList.remove("calendar-cell-new-fact"), { once: true });

  const rect = cell.getBoundingClientRect();
  const tip = document.createElement("div");
  tip.className = "calendar-cell-tooltip";
  tip.textContent = "Новый факт обо мне";
  tip.style.left = Math.round(rect.left + rect.width / 2) + "px";
  tip.style.top = Math.round(rect.top) + "px";
  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), 3200);
}

// При первом заходе в новый день привлекаем внимание к клетке факта, который только что
// "открылся" — per-day, а не одноразово (см. highlightNewFactCell).
function maybeShowDailyFact(){
  if(IS_ADMIN) return;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if(today < CALENDAR_START) return;
  const target = getBirthdayTarget(today);
  const latestOpened = today < target ? today : target;
  const key = dateKey(latestOpened);
  if(!DAILY_FACTS[key]) return;
  if(localStorage.getItem(LS.dailyFactSeen) === key) return;
  highlightNewFactCell(key);
  localStorage.setItem(LS.dailyFactSeen, key);
}

function initCountdown(){
  renderCountdown();
  setInterval(renderCountdown, 60 * 60 * 1000);
}

// ====== ВАЛЮТА ПРОСМОТРА (с конвертацией) ======
const CURRENCY_SYMBOL = { USD: "$", RUB: "₽", AMD: "AMD" };
let RATES = null; // сколько единиц валюты за 1 USD

async function loadRates(){
  try{
    const cached = JSON.parse(localStorage.getItem(LS.rates) || "null");
    if(cached && Date.now() - cached.ts < 12 * 3600 * 1000){
      RATES = cached.rates;
      renderAll();
      return;
    }
  }catch(e){ /* битый кэш — просто перезапросим */ }
  try{
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    if(!res.ok) return;
    const json = await res.json();
    if(json && json.rates){
      RATES = json.rates;
      localStorage.setItem(LS.rates, JSON.stringify({ ts: Date.now(), rates: RATES }));
      renderAll();
    }
  }catch(e){
    // Курсы не загрузились — просто показываем цены как есть, без конвертации.
  }
}

function convertAmount(amount, from, to){
  if(!RATES || !RATES[from] || !RATES[to]) return null;
  return amount / RATES[from] * RATES[to];
}

// Для сортировки по цене приводим всё к USD, чтобы честно сравнивать разные валюты.
// Если курсы ещё не загрузились — сравниваем как есть (лучше, чем ничего).
function priceForSort(item){
  const parsed = parsePriceValue(item);
  if(!parsed) return null;
  if(parsed.currency === "USD") return parsed.amount;
  const converted = convertAmount(parsed.amount, parsed.currency, "USD");
  return converted != null ? converted : parsed.amount;
}

function formatMoney(amount, currency){
  const rounded = Math.round(amount * 100) / 100;
  const display = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  const symbol = CURRENCY_SYMBOL[currency] || currency;
  return currency === "USD" ? `${symbol}${display}` : `${display} ${symbol}`;
}

// Понимает и новый формат {priceAmount, priceCurrency}, и старые цены-строки
// (например "5690 AMD" или "$46"), введённые до появления выбора валюты.
function parsePriceValue(item){
  if(item.priceAmount !== undefined && item.priceAmount !== null && item.priceAmount !== "" && item.priceCurrency){
    const amount = Number(item.priceAmount);
    if(!Number.isNaN(amount)) return { amount, currency: item.priceCurrency };
  }
  if(typeof item.price === "string" && item.price.trim()){
    return parseLegacyPriceString(item.price);
  }
  return null;
}

function parseLegacyPriceString(str){
  const s = str.trim();
  let currency = null;
  if(/\$/.test(s) || /\bUSD\b/i.test(s)) currency = "USD";
  else if(/₽/.test(s) || /\bRUB\b/i.test(s) || /руб/i.test(s)) currency = "RUB";
  else if(/AMD|֏|դր/i.test(s)) currency = "AMD";
  const numMatch = s.replace(/,/g, "").match(/\d+(\.\d+)?/);
  if(!currency || !numMatch) return null;
  return { amount: parseFloat(numMatch[0]), currency };
}

function displayPrice(item){
  const parsed = parsePriceValue(item);
  if(!parsed){
    return (typeof item.price === "string" && item.price.trim()) ? item.price : "";
  }
  const target = state.viewCurrency;
  if(target === "original" || target === parsed.currency){
    return formatMoney(parsed.amount, parsed.currency);
  }
  const converted = convertAmount(parsed.amount, parsed.currency, target);
  if(converted == null) return formatMoney(parsed.amount, parsed.currency);
  return formatMoney(converted, target);
}

// ====== ХРАНЕНИЕ (Firebase Realtime Database) ======
// Один список на весь сайт — отдельный per-list ID (как раньше JSONBin bin) не нужен:
// это выделенный Firebase-проект только для этого вишлиста.
let db = null;

function itemRef(id){
  return ref(db, "items/" + id);
}

function factRef(key){
  return ref(db, "facts/" + key);
}

// ====== "УМНОЕ" ЗАПОЛНЕНИЕ ПО ССЫЛКЕ ======
// Основной путь — свой Cloudflare Worker (собственный прокси с подменой User-Agent,
// без чужих rate limit'ов). Публичные CORS-прокси оставлены как запасной вариант —
// они регулярно падают или упираются в rate limit. Магазины вроде Amazon иногда
// всё равно отдают ботам капчу — тогда просто ничего не найдётся.
async function fetchWithTimeout(url, ms){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try{
    return await fetch(url, { signal: ctrl.signal });
  }finally{
    clearTimeout(timer);
  }
}

const HTML_PROXIES = [
  url => "https://winter-dust-4aa9.leritosha.workers.dev/?url=" + encodeURIComponent(url),
  url => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
  url => "https://api.cors.lol/?url=" + encodeURIComponent(url),
];

// Некоторые магазины (например Ozon) на любой автоматический запрос — с любого прокси,
// включая наш собственный Worker — отвечают HTTP 200 с страницей-заглушкой антибота
// вместо самого товара. Без этой проверки такая заглушка тихо подставлялась бы как
// заголовок товара. Настоящего обхода такой защиты нет — она требует полноценного
// браузера с JS, это уже не задача для простого прокси.
const BOT_BLOCK_TITLES = [/antibot challenge/i, /just a moment/i, /attention required/i, /access denied/i, /^403 forbidden$/i, /похоже,?\s*нет соединения/i];

function extractTitleTag(html){
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : "";
}

function isBotBlockPage(titleOrHtml){
  return BOT_BLOCK_TITLES.some(rx => rx.test(titleOrHtml));
}

async function fetchHtmlViaProxies(url){
  let lastError = null;
  for(const buildProxyUrl of HTML_PROXIES){
    try{
      const res = await fetchWithTimeout(buildProxyUrl(url), 9000);
      if(!res.ok) throw new Error("код " + res.status);
      const text = await res.text();
      if(isBotBlockPage(extractTitleTag(text))) throw new Error("сайт заблокировал автоматический просмотр");
      if(text && text.length > 200 && !/rate limit/i.test(text)) return text;
      lastError = new Error("прокси вернул пустой ответ");
    }catch(e){
      lastError = e;
    }
  }
  throw lastError || new Error("ни один прокси не ответил");
}

// <title> часто выглядит как "Магазин: Название товара : Категория" — вытаскиваем
// самый длинный кусок между двоеточиями, обычно это и есть само название.
function cleanupTitle(title){
  const parts = title.split(/\s*:\s*/).map(s => s.trim()).filter(Boolean);
  if(parts.length <= 1) return title.trim();
  return parts.reduce((a, b) => b.length > a.length ? b : a);
}

// Резервный вариант, когда все HTML-прокси недоступны: читаемый текст страницы
// без разметки — картинку и цену так не достать, но хотя бы название товара.
async function fetchTitleOnlyFallback(url){
  const res = await fetchWithTimeout("https://r.jina.ai/" + url, 9000);
  if(!res.ok) throw new Error("код " + res.status);
  const text = await res.text();
  const match = text.match(/^Title:\s*(.+)$/m);
  const title = match ? cleanupTitle(match[1]) : "";
  if(isBotBlockPage(title)) throw new Error("сайт заблокировал автоматический просмотр");
  return { title, image: "", images: [], price: "" };
}

async function fetchLinkPreview(url){
  let html;
  try{
    html = await fetchHtmlViaProxies(url);
  }catch(e){
    return await fetchTitleOnlyFallback(url);
  }
  const doc = new DOMParser().parseFromString(html, "text/html");

  const getMeta = (...names) => {
    for(const name of names){
      const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      const content = el && el.getAttribute("content");
      if(content && content.trim()) return content.trim();
    }
    return "";
  };

  const title = cleanupTitle(getMeta("og:title", "twitter:title") || (doc.querySelector("title")?.textContent || "").trim());

  // Сайт может отдавать несколько og:image (обычно то же самое фото в разных размерах,
  // но иногда — правда разные ракурсы товара).
  let images = Array.from(doc.querySelectorAll('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]'))
    .map(el => (el.getAttribute("content") || "").trim())
    .filter(Boolean);
  images = Array.from(new Set(images));

  if(images.length === 0){
    // Amazon не кладёт og:image на страницы товаров — главная картинка лежит в атрибутах
    // #landingImage (data-old-hires — уже готовая ссылка на полный размер), а остальные
    // ракурсы — в мини-превью галереи снизу (их приходится апскейлить вручную).
    const landing = doc.querySelector("#landingImage, #imgBlkFront");
    if(landing){
      let main = landing.getAttribute("data-old-hires") || "";
      if(!main){
        const dynamic = landing.getAttribute("data-a-dynamic-image");
        if(dynamic){
          try{ main = Object.keys(JSON.parse(dynamic))[0] || ""; }catch(e){ /* не JSON — пропускаем */ }
        }
      }
      if(!main) main = landing.getAttribute("src") || "";
      if(main) images.push(main);
    }
    doc.querySelectorAll("#altImages img").forEach(thumb => {
      const src = thumb.getAttribute("src") || "";
      const match = src.match(/^(https?:\/\/[^"']+\/images\/I\/[\w+-]+)\._[^."']+_\.(jpg|jpeg|png|gif)$/i);
      if(match){
        const upgraded = `${match[1]}._AC_SL1000_.${match[2]}`;
        if(!images.includes(upgraded)) images.push(upgraded);
      }
    });
  }

  const image = images[0] || "";

  let price = getMeta("product:price:amount", "og:price:amount");
  const currency = getMeta("product:price:currency", "og:price:currency");

  if(!price){
    const priceEl = doc.querySelector(
      '.a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, [itemprop="price"]'
    );
    if(priceEl){
      price = (priceEl.getAttribute("content") || priceEl.textContent || "").trim();
    }
  }

  if(!price){
    for(const script of doc.querySelectorAll('script[type="application/ld+json"]')){
      let parsed;
      try{ parsed = JSON.parse(script.textContent); }catch(e){ continue; }
      for(const block of Array.isArray(parsed) ? parsed : [parsed]){
        const offer = block?.offers?.[0] || block?.offers;
        if(offer?.price){ price = String(offer.price); break; }
      }
      if(price) break;
    }
  }

  if(price && currency && !/[a-zA-Zа-яА-Я₽$€]/.test(price)){
    price = `${price} ${currency}`;
  }

  return { title, image, images, price };
}

// ====== МОДАЛЬНЫЕ ОКНА ======
// closeOnBackdrop только для окон без ввода данных (просмотр карточки) — формы специально
// не закрываются по клику мимо, иначе случайный клик стирает то, что уже успели набрать.
function openModal(html, onMount, opts){
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "activeModal";
  overlay.innerHTML = `<div class="modal${opts && opts.wide ? " modal-wide" : ""}">${html}</div>`;
  if(opts && opts.closeOnBackdrop){
    overlay.addEventListener("click", e => { if(e.target === overlay) closeModal(); });
  }
  document.getElementById("modalRoot").appendChild(overlay);
  if(onMount) onMount(overlay);
}
function closeModal(){
  const m = document.getElementById("activeModal");
  if(m) m.remove();
}

// ====== ВХОД ВЛАДЕЛЬЦА ЧЕРЕЗ GOOGLE (Firebase Auth, как в leritonmap) ======
// Доступ владельца определяется email'ом из настоящего Google-аккаунта, а не паролем в коде.
// Firebase Auth сам хранит сессию между визитами — повторно логиниться не нужно.
// Работает только на admin-странице — гостевая страница вообще не инициирует вход.
let fbAuth = null;
let fbStorage = null;

function initFirebase(){
  try{
    const fbApp = initializeApp(CONFIG.FIREBASE_CONFIG);
    fbAuth = getAuth(fbApp);
    db = getDatabase(fbApp);
    fbStorage = getStorage(fbApp);
  }catch(e){
    console.error("Firebase init failed", e);
  }
}

// Загружает файлы фото в Firebase Storage (папка items/) и возвращает их постоянные ссылки.
async function uploadPhotoFiles(files){
  const urls = [];
  for(const file of files){
    const path = `items/${Date.now()}-${uid()}-${file.name}`.replace(/\s+/g, "_");
    const fileRef = storageRef(fbStorage, path);
    await uploadBytes(fileRef, file);
    urls.push(await getDownloadURL(fileRef));
  }
  return urls;
}

function initGoogleSignIn(){
  if(!fbAuth) return;
  onAuthStateChanged(fbAuth, user => {
    if(user && user.email === CONFIG.OWNER_EMAIL){
      state.isOwner = true;
      state.canSeeNames = false;
      state.ownerEmail = user.email;
    }else if(user && user.email === CONFIG.HELPER_EMAIL){
      state.isOwner = false;
      state.canSeeNames = true;
      state.ownerEmail = user.email;
    }else{
      if(user){
        // вошёл, но этот email не в списке допущенных
        showToast("У аккаунта " + user.email + " нет доступа", true);
        signOut(fbAuth);
      }
      state.isOwner = false;
      state.canSeeNames = false;
      state.ownerEmail = null;
    }
    renderAll();
  });
}

function signInOwner(){
  if(!fbAuth) return;
  const provider = new GoogleAuthProvider();
  signInWithPopup(fbAuth, provider).catch(err => {
    showToast("Не получилось войти: " + err.message, true);
  });
}

function ownerLogout(){
  if(fbAuth) signOut(fbAuth);
}

function openItemModal(existingItem){
  const isEdit = !!existingItem;
  const item = existingItem || { title:"", note:"", link:"", image:"", images:[] };
  const existingImages = (item.images && item.images.length) ? item.images : (item.image ? [item.image] : []);
  const parsedPrice = isEdit ? parsePriceValue(item) : null;
  const initialAmount = parsedPrice ? parsedPrice.amount : "";
  const initialCurrency = parsedPrice ? parsedPrice.currency : "AMD";
  const categoryOptions = Array.from(new Set([...FIXED_CATEGORIES, ...getAllCategories().filter(c => c !== NO_CATEGORY)]));

  openModal(`
    <h3>${isEdit ? "Редактировать подарок" : "Добавить подарок"}</h3>
    <div class="field">
      <label>Название *</label>
      <input type="text" id="fTitle" value="${escapeHtml(item.title)}">
    </div>
    <div class="field">
      <label>Категория</label>
      <select id="fCategory">
        <option value=""${item.category ? "" : " selected"}>Без категории</option>
        ${categoryOptions.map(c => `<option value="${escapeHtml(c)}"${item.category === c ? " selected" : ""}>${escapeHtml(c)}</option>`).join("")}
      </select>
    </div>
    <div class="field">
      <label class="filter-chip" style="font-weight:600;">
        <input type="checkbox" id="fAllowMultiple" ${item.allowMultiple ? "checked" : ""}>
        Можно подарить несколько штук (сертификаты, деньги и т.п.)
      </label>
      <small>Вместо "уже дарят" гости увидят счётчик "N человек выбрали это" и смогут присоединиться.</small>
    </div>
    <div class="field">
      <label>Закрепить в начале списка (порядок)</label>
      <input type="number" id="fPinOrder" value="${item.pinned === true ? "0" : (typeof item.pinned === "number" ? item.pinned : "")}" placeholder="Не закреплено">
      <small>Чем меньше число — тем раньше товар в списке (закреплённые всегда идут перед остальными). Пусто — обычный порядок.</small>
    </div>
    <div class="field">
      <label>Цена</label>
      <div class="price-row">
        <input type="number" step="0.01" id="fPriceAmount" value="${escapeHtml(initialAmount)}" placeholder="0">
        <select id="fPriceCurrency">
          <option value="USD"${initialCurrency === "USD" ? " selected" : ""}>USD $</option>
          <option value="RUB"${initialCurrency === "RUB" ? " selected" : ""}>RUB ₽</option>
          <option value="AMD"${initialCurrency === "AMD" ? " selected" : ""}>AMD</option>
        </select>
      </div>
    </div>
    <div class="field">
      <label>Ссылка</label>
      <input type="text" id="fLink" value="${escapeHtml(item.link)}" placeholder="https://...">
      <div style="margin-top:6px;display:flex;align-items:center;gap:10px;">
        <button type="button" class="secondary" id="fetchLinkBtn" style="font-size:.82rem;padding:6px 12px;">🔍 Подтянуть по ссылке</button>
        <span id="fetchLinkStatus" style="font-size:.8rem;color:var(--muted);"></span>
      </div>
    </div>
    <div class="field">
      <label>Картинки</label>
      <div style="margin-bottom:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <button type="button" class="secondary" id="uploadPhotosBtn" style="font-size:.82rem;padding:6px 12px;">📷 Загрузить фото</button>
        <input type="file" id="fPhotoFiles" accept="image/*" multiple style="display:none;">
        <span id="uploadPhotosStatus" style="font-size:.8rem;color:var(--muted);"></span>
      </div>
      <textarea id="fImages" placeholder="https://...">${escapeHtml(existingImages.join("\n"))}</textarea>
      <small>По одной ссылке на строку, или загрузите фото с устройства кнопкой выше — можно выбрать сразу несколько. Первая станет обложкой в списке.</small>
    </div>
    <div class="field">
      <label>Заметка</label>
      <textarea id="fNote">${escapeHtml(item.note)}</textarea>
    </div>
    <div class="error-text" id="itemError"></div>
    <div class="modal-actions">
      ${isEdit ? '<button class="danger left" id="deleteItemBtn">Удалить</button>' : ""}
      ${isEdit ? '<button class="secondary" id="unreserveBtn">Сбросить бронь</button>' : ""}
      <button class="secondary" id="cancelItem">Отмена</button>
      <button id="saveItem">Сохранить</button>
    </div>
  `, overlay => {
    overlay.querySelector("#fTitle").focus();
    overlay.querySelector("#cancelItem").addEventListener("click", closeModal);

    if(!isEdit){
      overlay.querySelector("#fLink").addEventListener("input", () => {
        const preset = matchLinkPreset(overlay.querySelector("#fLink").value.trim());
        if(!preset) return;
        const amountInput = overlay.querySelector("#fPriceAmount");
        if(!amountInput.value.trim()) overlay.querySelector("#fPriceCurrency").value = preset.currency;
        const noteField = overlay.querySelector("#fNote");
        if(!noteField.value.trim()) noteField.value = preset.pickupNote;
      });
    }

    overlay.querySelector("#fetchLinkBtn").addEventListener("click", async () => {
      const url = overlay.querySelector("#fLink").value.trim();
      const statusEl = overlay.querySelector("#fetchLinkStatus");
      if(!url){ statusEl.textContent = "Сначала вставьте ссылку"; return; }
      const btn = overlay.querySelector("#fetchLinkBtn");
      await withLoadingButton(btn, async () => {
        statusEl.textContent = "Загружаем…";
        try{
          const data = await fetchLinkPreview(url);
          const titleInput = overlay.querySelector("#fTitle");
          if(data.title && !titleInput.value.trim()) titleInput.value = data.title;
          if(data.images && data.images.length){
            overlay.querySelector("#fImages").value = data.images.join("\n");
          }else if(data.image){
            overlay.querySelector("#fImages").value = data.image;
          }
          if(data.price){
            const parsedScraped = parseLegacyPriceString(data.price);
            if(parsedScraped){
              overlay.querySelector("#fPriceAmount").value = parsedScraped.amount;
              overlay.querySelector("#fPriceCurrency").value = parsedScraped.currency;
            }
          }
          statusEl.textContent = (data.image || data.price || data.title)
            ? "Готово"
            : "Не нашли данные на странице — впишите вручную";
        }catch(e){
          statusEl.textContent = "Не получилось: " + e.message;
        }
      });
    });

    const photoFilesInput = overlay.querySelector("#fPhotoFiles");
    const uploadStatusEl = overlay.querySelector("#uploadPhotosStatus");
    overlay.querySelector("#uploadPhotosBtn").addEventListener("click", () => photoFilesInput.click());
    photoFilesInput.addEventListener("change", async () => {
      const files = Array.from(photoFilesInput.files || []);
      if(!files.length) return;
      const uploadBtn = overlay.querySelector("#uploadPhotosBtn");
      await withLoadingButton(uploadBtn, async () => {
        uploadStatusEl.textContent = `Загружаем ${files.length} фото…`;
        try{
          const urls = await uploadPhotoFiles(files);
          const imagesField = overlay.querySelector("#fImages");
          const existingLines = imagesField.value.split("\n").map(s => s.trim()).filter(Boolean);
          imagesField.value = [...existingLines, ...urls].join("\n");
          uploadStatusEl.textContent = `Загружено: ${urls.length}`;
        }catch(e){
          uploadStatusEl.textContent = "Не получилось: " + e.message;
        }finally{
          photoFilesInput.value = "";
        }
      });
    });

    if(isEdit){
      overlay.querySelector("#deleteItemBtn").addEventListener("click", async () => {
        if(!confirm("Удалить этот подарок из списка?")) return;
        await withLoadingButton(overlay.querySelector("#deleteItemBtn"), async () => {
          await remove(itemRef(item.id));
          closeModal();
          showToast("Подарок удалён");
        });
      });
      const unreserveBtn = overlay.querySelector("#unreserveBtn");
      if(unreserveBtn){
        unreserveBtn.addEventListener("click", async () => {
          await withLoadingButton(unreserveBtn, async () => {
            await update(itemRef(item.id), { reservedBy: "", reservedByMulti: null });
            closeModal();
            showToast("Готово");
          });
        });
      }
    }

    overlay.querySelector("#saveItem").addEventListener("click", async () => {
      const title = overlay.querySelector("#fTitle").value.trim();
      if(!title){
        overlay.querySelector("#itemError").textContent = "Введите название";
        return;
      }
      const amountRaw = overlay.querySelector("#fPriceAmount").value.trim();
      const imagesList = overlay.querySelector("#fImages").value
        .split("\n").map(s => s.trim()).filter(Boolean);
      const pinOrderRaw = overlay.querySelector("#fPinOrder").value.trim();
      const data = {
        title,
        category: overlay.querySelector("#fCategory").value.trim() || null,
        link: overlay.querySelector("#fLink").value.trim(),
        images: imagesList.length ? imagesList : null,
        image: imagesList.length ? imagesList[0] : null,
        note: overlay.querySelector("#fNote").value.trim(),
        priceAmount: amountRaw ? Number(amountRaw) : null,
        priceCurrency: amountRaw ? overlay.querySelector("#fPriceCurrency").value : null,
        price: null, // на случай редактирования старой записи со старым текстовым полем цены
        allowMultiple: overlay.querySelector("#fAllowMultiple").checked || null,
        pinned: pinOrderRaw ? Number(pinOrderRaw) : null,
      };
      const saveBtn = overlay.querySelector("#saveItem");
      await withLoadingButton(saveBtn, async () => {
        try{
          if(isEdit){
            await update(itemRef(item.id), data);
          }else{
            delete data.price;
            const newItem = { reservedBy: "", ...data };
            await set(itemRef(uid()), newItem);
          }
          closeModal();
          showToast("Сохранено");
        }catch(e){
          overlay.querySelector("#itemError").textContent = e.message;
        }
      });
    });
  });
}

// Лёгкая конфетти на canvas без внешних библиотек/JSON-ассетов — визуально тот же эффект,
// что даёт lottie-анимация конфетти, но без веса lottie-web и риска, что хот-линкнутый файл
// когда-нибудь пропадёт.
function launchConfetti(canvas){
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const colors = ["#e8823f", "#ff9d54", "#6b4fa3", "#3fa672", "#d9455f", "#ffd166", "#4cc98a"];
  const pieces = Array.from({ length: 140 }, () => ({
    x: Math.random() * w,
    y: -20 - Math.random() * h * 0.6,
    size: 6 + Math.random() * 6,
    color: colors[Math.floor(Math.random() * colors.length)],
    speed: 2 + Math.random() * 3,
    drift: (Math.random() - 0.5) * 2,
    rotation: Math.random() * 360,
    rotSpeed: (Math.random() - 0.5) * 12,
  }));

  let frame = 0;
  const totalFrames = 220; // ~3.5с при 60fps
  function tick(){
    ctx.clearRect(0, 0, w, h);
    pieces.forEach(p => {
      p.y += p.speed;
      p.x += p.drift;
      p.rotation += p.rotSpeed;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation * Math.PI / 180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    });
    frame++;
    if(frame < totalFrames && document.body.contains(canvas)) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, w, h);
  }
  requestAnimationFrame(tick);
}

// Большой попап-благодарность поверх всего экрана после успешной брони — конфетти на весь
// экран + тёплый текст. Закрывается только по клику/кнопке — таймаута нет, висит, пока
// пользователь сам не закроет.
function showThanksPopup(){
  const overlay = document.createElement("div");
  overlay.className = "thanks-overlay";
  overlay.innerHTML = `
    <canvas class="thanks-confetti"></canvas>
    <div class="thanks-card">
      <div class="thanks-emoji">🎉</div>
      <h2>Огромное спасибо!</h2>
      <p>С большим удовольствием жду сюрприз 🎁 и обязательно запишу видео-распаковку, чтобы вы увидели мои эмоции!</p>
      <button class="secondary" id="thanksCloseBtn">Закрыть</button>
    </div>
  `;
  document.body.appendChild(overlay);
  launchConfetti(overlay.querySelector(".thanks-confetti"));
  const close = () => overlay.remove();
  overlay.querySelector("#thanksCloseBtn").addEventListener("click", close);
  overlay.addEventListener("click", e => { if(e.target === overlay) close(); });
}

function openReserveModal(item){
  openModal(`
    <h3>Хочу подарить «${escapeHtml(item.title)}»</h3>
    <div class="field">
      <label>Ваше имя</label>
      <input type="text" id="reserveName" placeholder="Например, Анна">
      <small>Никому не покажем — понадобится только чтобы отменить, если передумаете.</small>
    </div>
    <div class="error-text" id="reserveError"></div>
    <div class="modal-actions">
      <button class="secondary" id="cancelReserve">Отмена</button>
      <button id="confirmReserve">Хочу подарить</button>
    </div>
  `, overlay => {
    const input = overlay.querySelector("#reserveName");
    input.focus();
    overlay.querySelector("#cancelReserve").addEventListener("click", closeModal);
    const submit = async () => {
      const name = input.value.trim();
      if(!name){
        overlay.querySelector("#reserveError").textContent = "Введите имя";
        return;
      }
      const btn = overlay.querySelector("#confirmReserve");
      await withLoadingButton(btn, async () => {
        try{
          if(item.allowMultiple){
            // Можно дарить несколько штук — просто добавляем свою запись в список, никого не
            // блокируя. Ключ случайный (не само имя), чтобы в имени можно было использовать
            // любые символы без риска сломать путь в Firebase.
            await update(itemRef(item.id), { [`reservedByMulti/${uid()}`]: name });
          }else{
            const current = state.items.find(i => i.id === item.id);
            if(current && current.reservedBy) throw new Error("Этот подарок уже хотят подарить");
            await update(itemRef(item.id), { reservedBy: name });
          }
          closeModal();
          showThanksPopup();
        }catch(e){
          overlay.querySelector("#reserveError").textContent = e.message;
        }
      });
    };
    overlay.querySelector("#confirmReserve").addEventListener("click", submit);
    input.addEventListener("keydown", e => { if(e.key === "Enter") submit(); });
  });
}

function openCancelReserveModal(item){
  openModal(`
    <h3>Передумали дарить «${escapeHtml(item.title)}»?</h3>
    <p style="font-size:.88rem;color:var(--muted);margin-top:-6px;">Введите имя, которое указали, чтобы отменить.</p>
    <div class="field">
      <label>Имя</label>
      <input type="text" id="cancelName">
    </div>
    <div class="error-text" id="cancelError"></div>
    <div class="modal-actions">
      <button class="secondary" id="cancelCancelReserve">Назад</button>
      <button class="danger" id="confirmCancelReserve">Отменить</button>
    </div>
  `, overlay => {
    const input = overlay.querySelector("#cancelName");
    input.focus();
    overlay.querySelector("#cancelCancelReserve").addEventListener("click", closeModal);
    overlay.querySelector("#confirmCancelReserve").addEventListener("click", async () => {
      const name = input.value.trim();
      if(!name){
        overlay.querySelector("#cancelError").textContent = "Введите имя";
        return;
      }
      const btn = overlay.querySelector("#confirmCancelReserve");
      await withLoadingButton(btn, async () => {
        try{
          if(item.allowMultiple){
            const entries = Object.entries(item.reservedByMulti || {});
            const match = entries.find(([, n]) => n.toLowerCase() === name.toLowerCase());
            if(!match) throw new Error("Имя не совпадает");
            await update(itemRef(item.id), { [`reservedByMulti/${match[0]}`]: null });
          }else{
            if(name.toLowerCase() !== (item.reservedBy||"").toLowerCase()) throw new Error("Имя не совпадает");
            await update(itemRef(item.id), { reservedBy: "" });
          }
          closeModal();
          showToast("Отменено");
        }catch(e){
          overlay.querySelector("#cancelError").textContent = e.message;
        }
      });
    });
  });
}

// Полная карточка товара по клику: галерея фото + вся информация без обрезки.
function openDetailModal(item){
  const images = (item.images && item.images.length) ? item.images : (item.image ? [item.image] : []);
  const price = displayPrice(item);
  const mainImageHtml = images.length
    ? `<img id="detailMainImg" src="${escapeHtml(images[0])}" alt="" onerror="this.parentElement.innerHTML='🎁'">`
    : "🎁";
  const thumbsHtml = images.length > 1
    ? `<div class="detail-thumbs">${images.map((src, i) => `<img src="${escapeHtml(src)}" class="detail-thumb${i === 0 ? " active" : ""}" data-src="${escapeHtml(src)}">`).join("")}</div>`
    : "";

  // Владельцу статус брони не показываем нигде, включая эту детальную карточку — см. renderCardFooter.
  const reservedLine = (item.reservedBy && state.canSeeNames)
    ? `<div class="reserved-badge" style="display:inline-flex;margin-bottom:10px;">🎁 Хотят подарить: ${escapeHtml(item.reservedBy)}</div>`
    : "";

  openModal(`
    <div class="detail-main-img">${mainImageHtml}</div>
    ${thumbsHtml}
    <h3>${escapeHtml(item.title)}</h3>
    ${price ? `<div class="card-price" style="font-size:1.15rem;margin-bottom:10px;">${escapeHtml(price)}</div>` : ""}
    ${reservedLine}
    ${item.note ? `<p class="card-note" style="white-space:pre-wrap;">${renderNoteWithCopyBoxes(item.note)}</p>` : ""}
    ${item.link ? `<div class="card-link" style="margin:10px 0;"><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">Открыть ссылку →</a></div>` : ""}
    <div class="modal-actions" id="detailActions"></div>
  `, overlay => {
    overlay.querySelectorAll(".detail-thumb").forEach(thumb => {
      thumb.addEventListener("click", () => {
        overlay.querySelector("#detailMainImg").src = thumb.dataset.src;
        overlay.querySelectorAll(".detail-thumb").forEach(t => t.classList.remove("active"));
        thumb.classList.add("active");
      });
    });
    overlay.querySelectorAll(".note-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => copyNoteValue(btn.dataset.copy));
    });

    const actions = overlay.querySelector("#detailActions");
    if(state.isOwner){
      actions.innerHTML = `<button class="secondary" id="detailClose">Закрыть</button><button id="detailEdit">✎ Редактировать</button>`;
      actions.querySelector("#detailEdit").addEventListener("click", () => openItemModal(item));
    }else if(state.canSeeNames){
      actions.innerHTML = `<button class="secondary" id="detailClose">Закрыть</button>`;
    }else if(IS_ADMIN){
      // До входа на админ-странице — то же самое, никакой брони.
      actions.innerHTML = `<button class="secondary" id="detailClose">Закрыть</button>`;
    }else if(item.reservedBy){
      actions.innerHTML = `<button class="secondary" id="detailClose">Закрыть</button><button class="ghost" id="detailCancel">Отменить</button>`;
      actions.querySelector("#detailCancel").addEventListener("click", () => openCancelReserveModal(item));
    }else{
      actions.innerHTML = `<button class="secondary" id="detailClose">Закрыть</button><button id="detailReserve">Хочу подарить</button>`;
      actions.querySelector("#detailReserve").addEventListener("click", () => openReserveModal(item));
    }
    actions.querySelector("#detailClose").addEventListener("click", closeModal);
  }, { closeOnBackdrop: true, wide: true });
}

async function withLoadingButton(btn, fn){
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try{
    await fn();
  }catch(e){
    showToast(e.message || "Ошибка", true);
  }finally{
    if(document.body.contains(btn)){
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}

// ====== РЕНДЕР ======
function renderAll(){
  renderOwnerControls();
  renderMain();
  // Пересчитываем и календарик — от него зависит, кликабельны ли клетки (владелец после входа
  // может редактировать любую), а это меняется при смене state.isOwner.
  renderCountdown();
}

function renderOwnerControls(){
  const el = $("#ownerControls");
  if(!el) return;
  if(!IS_ADMIN){
    el.innerHTML = "";
    return;
  }
  if(state.isOwner){
    el.innerHTML = `
      <span style="color:var(--muted);font-size:.82rem;">${escapeHtml(state.ownerEmail || "")}</span>
      <button class="secondary" id="btnAddItem">+ Добавить подарок</button>
      <button class="ghost" id="btnLogout">Выйти</button>
    `;
    $("#btnAddItem").addEventListener("click", () => openItemModal(null));
    $("#btnLogout").addEventListener("click", ownerLogout);
  }else if(state.canSeeNames){
    el.innerHTML = `
      <span style="color:var(--muted);font-size:.82rem;">${escapeHtml(state.ownerEmail || "")} · только просмотр</span>
      <button class="ghost" id="btnLogout">Выйти</button>
    `;
    $("#btnLogout").addEventListener("click", ownerLogout);
  }else{
    el.innerHTML = `<button class="secondary" id="googleSignInBtn">Войти через Google</button>`;
    $("#googleSignInBtn").addEventListener("click", signInOwner);
  }
}

function renderMain(){
  const el = $("#main");
  if(!el) return;

  if(state.loading){
    el.innerHTML = `<div class="spinner-row">Загрузка…</div>`;
    return;
  }

  if(state.items.length === 0){
    el.innerHTML = state.isOwner
      ? `<div class="empty-state"><h2>Список пока пуст</h2><p>Добавьте первый подарок кнопкой выше.</p></div>`
      : `<div class="empty-state"><h2>Список пуст</h2><p>Пока здесь ничего нет.</p></div>`;
    return;
  }

  // Кнопку "инфо" достаём из DOM перед перерисовкой (иначе innerHTML её уничтожит, если она уже
  // переехала в панель фильтров на прошлом рендере) и возвращаем на место в filtersBar ниже.
  const infoBtn = document.getElementById("infoBtn");
  infoBtn?.remove();

  const categories = getAllCategories();
  // Пустой выбор категорий значит "показать всё" — отмечать нужно только то, что хочешь увидеть,
  // а не снимать галочки со всего остального.
  let visibleItems = state.items.filter(item => state.selectedCategories.size === 0 || state.selectedCategories.has(categoryOf(item)));
  // Отложенные товары видит только владелец (полупрозрачными, см. renderCard) — все остальные
  // роли их вообще не видят, ни гости, ни хелпер.
  if(!state.isOwner) visibleItems = visibleItems.filter(item => !item.postponed);
  if(state.onlyMarketplace) visibleItems = visibleItems.filter(item => !!matchLinkPreset(item.link || ""));

  if(state.sortBy === "price_asc" || state.sortBy === "price_desc"){
    const dir = state.sortBy === "price_asc" ? 1 : -1;
    visibleItems = visibleItems.slice().sort((a, b) => {
      const pa = priceForSort(a), pb = priceForSort(b);
      if(pa == null && pb == null) return 0;
      if(pa == null) return 1;  // без цены — в конец списка
      if(pb == null) return -1;
      return (pa - pb) * dir;
    });
  }
  // Закреплённые товары всегда идут первыми, независимо от сортировки — сортировка стабильна,
  // так что порядок среди остальных не трогаем. pinned может быть числом (явный ранг — чем
  // меньше, тем раньше) или просто true (старый формат, без конкретного места в очереди).
  const pinRank = item => item.pinned === true ? 0 : (typeof item.pinned === "number" ? item.pinned : Infinity);
  visibleItems = visibleItems.slice().sort((a, b) => pinRank(a) - pinRank(b));

  // Заголовки дропдаунов фиксированные ("Сортировка"/"Категории") и не отражают текущий
  // выбор — раньше там был текущий вариант, и это смотрелось странно (особенно с длинными названиями).
  const dropdownArrow = `<svg class="dropdown-check-arrow" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 8 10 13 15 8"/></svg>`;
  const sortOptions = [
    ["default", "Порядок: по умолчанию"],
    ["price_asc", "Цена: сначала дешёвые"],
    ["price_desc", "Цена: сначала дорогие"],
  ];

  const filtersBar = `
    <div class="filters-bar">
      <details class="dropdown-check" id="sortDropdown"${openDropdownId === "sortDropdown" ? " open" : ""}>
        <summary class="dropdown-check-toggle">
          <span>Сортировка</span>
          ${dropdownArrow}
        </summary>
        <div class="dropdown-check-panel">
          ${sortOptions.map(([value, label]) => `
            <label class="filter-chip">
              <input type="radio" name="sortRadio" class="sortRadio" value="${value}" ${state.sortBy === value ? "checked" : ""}>
              ${escapeHtml(label)}
            </label>
          `).join("")}
        </div>
      </details>
      <details class="dropdown-check" id="categoryDropdown"${openDropdownId === "categoryDropdown" ? " open" : ""}>
        <summary class="dropdown-check-toggle">
          <span>Категории</span>
          ${dropdownArrow}
        </summary>
        <div class="dropdown-check-panel">
          ${categories.map(cat => `
            <label class="filter-chip">
              <input type="checkbox" class="categoryFilterCheckbox" value="${escapeHtml(cat)}" ${state.selectedCategories.has(cat) ? "checked" : ""}>
              ${escapeHtml(cat)}
            </label>
          `).join("")}
        </div>
      </details>
      <label class="filter-chip marketplace-filter">
        <input type="checkbox" id="onlyMarketplaceCheckbox" ${state.onlyMarketplace ? "checked" : ""}>
        <span class="marketplace-label-full">Можно купить на Ozon</span>
        <span class="marketplace-label-short">Ozon</span>
      </label>
      ${!IS_ADMIN ? '<span id="infoBtnSlot"></span>' : ""}
    </div>
  `;

  const list = visibleItems.length
    ? `<div class="grid">${visibleItems.map(renderCard).join("")}</div>`
    : `<div class="empty-state"><h2>Ничего не найдено</h2><p>Попробуйте включить другие категории.</p></div>`;

  el.innerHTML = filtersBar + list;
  if(infoBtn) el.querySelector("#infoBtnSlot")?.replaceWith(infoBtn);

  el.querySelectorAll(".dropdown-check").forEach(details => {
    details.addEventListener("toggle", () => {
      openDropdownId = details.open ? details.id : null;
    });
  });
  el.querySelectorAll(".categoryFilterCheckbox").forEach(cb => {
    cb.addEventListener("change", () => {
      if(cb.checked) state.selectedCategories.add(cb.value);
      else state.selectedCategories.delete(cb.value);
      renderMain();
    });
  });
  el.querySelectorAll(".sortRadio").forEach(radio => {
    radio.addEventListener("change", () => {
      state.sortBy = radio.value;
      openDropdownId = null; // выбор одного варианта — дропдаун закрывается сам
      renderMain();
    });
  });
  const onlyMarketplaceCheckbox = el.querySelector("#onlyMarketplaceCheckbox");
  if(onlyMarketplaceCheckbox){
    onlyMarketplaceCheckbox.addEventListener("change", () => {
      state.onlyMarketplace = onlyMarketplaceCheckbox.checked;
      renderMain();
    });
  }

  visibleItems.forEach(item => {
    const card = el.querySelector(`[data-id="${item.id}"]`);
    if(!card) return;
    card.addEventListener("click", e => {
      if(e.target.closest("button, a")) return; // у кнопок и ссылок своё поведение
      openDetailModal(item);
    });
    // Если комментарий обрезался по 4 строкам — добавляем "подробнее", открывающее ту же карточку.
    const noteEl = card.querySelector(".card-note-clamp");
    if(noteEl && noteEl.scrollHeight > noteEl.clientHeight + 1){
      const moreLink = document.createElement("span");
      moreLink.className = "card-note-more";
      moreLink.textContent = "подробнее";
      moreLink.addEventListener("click", e => { e.stopPropagation(); openDetailModal(item); });
      noteEl.insertAdjacentElement("afterend", moreLink);
    }
    const cardImages = (item.images && item.images.length) ? item.images : (item.image ? [item.image] : []);
    if(cardImages.length > 1){
      const cardImgBox = card.querySelector(".card-img");
      const mainImg = cardImgBox.querySelector(".card-img-main");
      const dots = Array.from(cardImgBox.querySelectorAll(".card-img-dot"));
      let currentIdx = 0;
      const setIdx = idx => {
        currentIdx = Math.min(cardImages.length - 1, Math.max(0, idx));
        mainImg.src = cardImages[currentIdx];
        dots.forEach((dot, i) => dot.classList.toggle("active", i === currentIdx));
      };
      cardImgBox.addEventListener("mousemove", e => {
        const rect = cardImgBox.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        setIdx(Math.floor(ratio * cardImages.length));
      });
      // При уходе курсора ничего не сбрасываем — так и должна остаться последняя показанная фотография.

      // На мобильных мыши нет — свайп по фото листает картинки. В отличие от десктопного
      // наведения (где курсор двигается по всей ширине и можно непрерывно "сканировать"
      // позицию), палец обычно проходит только часть ширины карточки за один жест — так что
      // вместо пересчёта по абсолютной позиции один свайп просто листает на одну фотку вперёд
      // или назад, по направлению движения. Гейтим на горизонтальность жеста, чтобы не мешать
      // обычному вертикальному скроллу страницы, и гасим клик по карточке после свайпа, чтобы
      // не открывалась детальная карточка товара.
      let touchStartX = 0, touchStartY = 0, swiping = false, justSwiped = false;
      cardImgBox.addEventListener("touchstart", e => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        swiping = false;
      }, { passive: true });
      cardImgBox.addEventListener("touchmove", e => {
        const dx = e.touches[0].clientX - touchStartX;
        const dy = e.touches[0].clientY - touchStartY;
        if(!swiping && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) swiping = true;
        if(swiping) e.preventDefault();
      }, { passive: false });
      cardImgBox.addEventListener("touchend", e => {
        if(!swiping) return;
        justSwiped = true;
        const dx = e.changedTouches[0].clientX - touchStartX;
        if(dx <= -24) setIdx(currentIdx + 1);
        else if(dx >= 24) setIdx(currentIdx - 1);
      });
      cardImgBox.addEventListener("click", e => {
        if(justSwiped){ e.stopPropagation(); justSwiped = false; }
      });
    }
    if(state.isOwner){
      card.querySelector(".editBtn")?.addEventListener("click", () => openItemModal(item));
      card.querySelector(".postponeBtn")?.addEventListener("click", async () => {
        await update(itemRef(item.id), { postponed: !item.postponed });
        showToast(item.postponed ? "Возвращено в список" : "Отложено");
      });
    }else if(!state.canSeeNames){
      card.querySelector(".reserveBtn")?.addEventListener("click", () => openReserveModal(item));
      card.querySelector(".cancelReserveBtn")?.addEventListener("click", () => openCancelReserveModal(item));
    }
  });
}

// Кнопки "написать в Telegram" — живут только в шапке и в попапе с объяснением брони,
// не в самих карточках. Раньше лежали в каждой карточке рядом с отметкой брони, и это
// создавало ложное впечатление, что это Лера что-то забронировала.
const TELEGRAM_ICON_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635.099-.002.321.023.465.14.121.098.153.23.169.324.016.093.036.306.02.472z"/></svg>`;

function renderTopContacts(){
  const el = $("#topContacts");
  if(!el) return;
  el.innerHTML = CONFIG.CONTACTS.map(c => `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" class="contact-link">${TELEGRAM_ICON_SVG} ${escapeHtml(c.name)}</a>`).join("");
}

// Попап-объяснение для гостей: что это за список, как бронировать и отменять бронь,
// куда писать с вопросами. Показывается сам при первом визите (см. maybeShowIntro),
// плюс доступен в любой момент по кнопке ℹ️ в шапке.
function openIntroModal(){
  // Лера слева, Антон справа в этом попапе — порядок только для этих двух кнопок,
  // глобальный CONFIG.CONTACTS (шапка, карточки) не трогаем.
  const popupContacts = [...CONFIG.CONTACTS].reverse();
  openModal(`
    <h3>🎁 Вишлист Антона</h3>
    <p class="intro-text">Здесь — то, что его порадует. Выбирайте на свой вкус!</p>
    <p class="intro-text"><strong>Как забронировать</strong><br>Нажмите «Хочу подарить»,<br>впишите имя — его увидите только вы.<br>Антон брони не видит, сюрприз останется сюрпризом 🤫</p>
    <p class="intro-text"><strong>Если передумали</strong><br>Нажмите «Отменить» на выбранном подарке, введите своё имя.</p>
    <p class="intro-text"><strong>Есть вопросы?</strong><br>Пишите Лере — подскажет по размеру, цвету и другим деталям.<br>Антону тоже можно написать напрямую 😉</p>
    <div class="popup-contacts">
      <div class="popup-contacts-label">Написать:</div>
      <div class="popup-contacts-btns">
        ${popupContacts.map(c => `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" class="contact-btn">${TELEGRAM_ICON_SVG} ${escapeHtml(c.name)}</a>`).join("")}
      </div>
    </div>
    <div class="modal-actions modal-actions-center">
      <button id="introCloseBtn">Понятно, спасибо!</button>
    </div>
  `, overlay => {
    overlay.querySelector("#introCloseBtn").addEventListener("click", closeModal);
  }, { closeOnBackdrop: true });
}

function maybeShowIntro(){
  if(IS_ADMIN) return;
  if(localStorage.getItem(LS.introSeen)) return;
  openIntroModal();
  localStorage.setItem(LS.introSeen, "1");
}

function renderCard(item){
  const images = (item.images && item.images.length) ? item.images : (item.image ? [item.image] : []);
  const img = images.length
    ? `<img class="card-img-main" src="${escapeHtml(images[0])}" alt="" onerror="this.parentElement.innerHTML='🎁'">`
    : "🎁";
  const dots = images.length > 1
    ? `<div class="card-img-dots">${images.map((_, i) => `<span class="card-img-dot${i === 0 ? " active" : ""}"></span>`).join("")}</div>`
    : "";
  const price = displayPrice(item);
  return `
    <div class="card${state.isOwner && item.postponed ? " card-postponed" : ""}" data-id="${escapeHtml(item.id)}">
      ${state.isOwner ? `
        <div class="owner-actions">
          <button class="secondary editBtn" title="Редактировать">✎</button>
          <button class="secondary postponeBtn" title="${item.postponed ? "Вернуть в список" : "Отложить (скрыть из публичного списка)"}">${item.postponed ? "↩" : "⏸"}</button>
        </div>
      ` : ""}
      <div class="card-img">${img}${dots}</div>
      <div class="card-body">
        <p class="card-title">${item.link
          ? `<a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>`
          : escapeHtml(item.title)}</p>
        ${price ? `<div class="card-price">${escapeHtml(price)}</div>` : ""}
        ${item.note ? `<p class="card-note card-note-clamp">${linkifyText(item.note)}</p>` : ""}
        <div class="card-footer">
          ${renderCardFooter(item)}
        </div>
      </div>
    </div>
  `;
}

function peopleWord(n){
  const mod10 = n % 10, mod100 = n % 100;
  if(mod100 >= 11 && mod100 <= 14) return "человек";
  if(mod10 === 1) return "человек";
  if(mod10 >= 2 && mod10 <= 4) return "человека";
  return "человек";
}

// "1 человек выбрал" (ед. число), но "2/5/11 человек выбрали" (мн. число) — отдельное согласование
// от peopleWord(), у глагола своё правило (единственное только когда число оканчивается на 1, но
// не на 11).
function chooseVerb(n){
  const mod10 = n % 10, mod100 = n % 100;
  return (mod10 === 1 && mod100 !== 11) ? "выбрал" : "выбрали";
}

// Компактная кнопка отмены — серый крестик, на десктопе разворачивается в "Отменить" при
// наведении (на тач-устройствах наведения нет, крестик так и остаётся компактным, но кликабелен).
const CANCEL_X_BTN = `<button class="cancel-x-btn cancelReserveBtn" title="Отменить" aria-label="Отменить"><span class="cancel-x-icon">✕</span><span class="cancel-x-label">Отменить</span></button>`;

function renderCardFooter(item){
  // Владелец (получатель подарков) сюрприз не видит вообще — ни факта брони, ни имени,
  // иначе сюрприза не остаётся. Хелпер (жена) видит имя, чтобы координировать подарки,
  // но список не редактирует.
  if(state.isOwner) return "";
  if(state.canSeeNames){
    if(item.allowMultiple){
      const names = item.reservedByMulti ? Object.values(item.reservedByMulti) : [];
      if(!names.length) return `<span style="color:var(--muted);font-size:.85rem;">Свободно</span>`;
      return `<span class="reserved-badge">🎁 Дарят: ${names.map(escapeHtml).join(", ")}</span>`;
    }
    if(!item.reservedBy) return `<span style="color:var(--muted);font-size:.85rem;">Свободно</span>`;
    return `<span class="reserved-badge">🎁 Хотят подарить: ${escapeHtml(item.reservedBy)}</span>`;
  }
  // На админ-странице до входа владельца/хелпера бронировать нечем — это переходное состояние,
  // а не гостевой просмотр, так что кнопки "Хочу подарить" тут вообще быть не должно.
  if(IS_ADMIN) return "";
  if(item.allowMultiple){
    // Можно дарить несколько штук — вместо блокировки показываем счётчик и не прячем кнопку
    // "Хочу подарить" (можно присоединиться), а рядом — компактная отмена для тех, кто уже
    // записался (какое именно имя — проверяется в самом попапе отмены, как и раньше).
    // Бейдж и крестик отмены — первыми, кнопка "Хочу подарить" (full-btn, во всю ширину) —
    // последней: так она сама переносится на отдельную строку под ними, а не ломает раскладку,
    // пытаясь встать в 100% ширины ПЕРЕД остальными элементами строки.
    const count = item.reservedByMulti ? Object.keys(item.reservedByMulti).length : 0;
    return `
      ${count > 0 ? `<span class="reserved-badge">🎁 ${count} ${peopleWord(count)} ${chooseVerb(count)} это</span>` : ""}
      ${count > 0 ? CANCEL_X_BTN : ""}
      <button class="full-btn reserveBtn">Хочу подарить</button>
    `;
  }
  if(item.reservedBy){
    // Имя не показываем гостям — его же нужно ввести, чтобы отменить. Покажи мы его тут,
    // любой гость мог бы подсмотреть и отменить чужую отметку.
    return `
      <span class="reserved-badge">🎁 Уже дарят</span>
      ${CANCEL_X_BTN}
    `;
  }
  return `<button class="full-btn reserveBtn">Хочу подарить</button>`;
}

// Живая подписка на список — при любом изменении (своём или чужом) экран обновляется сам.
function watchItems(){
  if(!db){
    state.loading = false;
    renderAll();
    return;
  }
  onValue(ref(db, "items"), snap => {
    const val = snap.val() || {};
    state.items = Object.keys(val).map(id => ({ id, reservedBy: "", ...val[id] }));
    state.loading = false;
    renderAll();
  }, err => {
    showToast(err.message, true);
    state.loading = false;
    renderAll();
  });
}

// Живая подписка на факты дня — хранятся в Firebase как HTML (см. openFactEditModal),
// редактируются владельцем прямо на сайте. Пока не подгрузились (или их там ещё нет) —
// используем захардкоженный DEFAULT_DAILY_FACTS.
let introAlreadySeenAtStart = false;
let dailyFactAutoCheckDone = false;
function maybeRunDailyFactAutoCheck(){
  if(IS_ADMIN || dailyFactAutoCheckDone) return;
  dailyFactAutoCheckDone = true;
  if(introAlreadySeenAtStart) maybeShowDailyFact();
}
function watchFacts(){
  if(!db){ maybeRunDailyFactAutoCheck(); return; }
  onValue(ref(db, "facts"), snap => {
    const val = snap.val() || {};
    const fromDb = {};
    Object.keys(val).forEach(key => {
      const html = String(val[key] || "").trim();
      if(html) fromDb[key] = html;
    });
    DAILY_FACTS = { ...DEFAULT_DAILY_FACTS, ...fromDb };
    renderCountdown();
    maybeRunDailyFactAutoCheck();
  }, () => {
    maybeRunDailyFactAutoCheck();
  });
}

// Счётчик уникальных посетителей — раз за браузер (см. LS.viewCounted), гостей, не владельца.
// runTransaction нужен, а не просто set(текущее+1) — иначе параллельные гости друг друга
// перезатирают (оба читают одно и то же старое значение и оба пишут одно и то же +1).
// Требует отдельного правила в Firebase Security Rules на запись в stats/viewCount — без него
// транзакция просто тихо падает с PERMISSION_DENIED, и счётчик остаётся на месте (не критично).
function maybeCountView(){
  if(IS_ADMIN || !db) return;
  if(localStorage.getItem(LS.viewCounted)) return;
  runTransaction(ref(db, "stats/viewCount"), current => (current || 0) + 1)
    .then(() => localStorage.setItem(LS.viewCounted, "1"))
    .catch(() => { /* нет доступа или сеть — просто не засчиталось в этот раз */ });
}

// Живая подписка на общее число посетителей — двигает интенсивность звездопада
// (см. starsPerBurst выше). Не нужна владельцу отдельно — просто не вредит, поэтому подписываем
// всех одинаково.
function watchViewCount(){
  if(!db) return;
  onValue(ref(db, "stats/viewCount"), snap => {
    siteViewCount = Number(snap.val()) || 0;
  }, () => { /* нет доступа (правило ещё не добавлено) — просто остаёмся с дефолтом 0 */ });
}

// ====== СТАРТ ======
export function initApp(opts){
  IS_ADMIN = !!(opts && opts.isAdmin);
  initTheme();
  initSky();
  initShootingStars();
  initCountdown();
  initFirebase();
  renderAll();
  if(IS_ADMIN){
    initGoogleSignIn();
  }else{
    renderTopContacts();
    initTitleLetters();
    $("#titleClickTarget")?.addEventListener("click", handleTitleClick);
    $("#infoBtn")?.addEventListener("click", openIntroModal);
    // openModal() закрывает предыдущий попап, так что оба сразу показать нельзя — в самый
    // первый визит приоритет у интро (объясняет весь сайт). Факт дня показываем только после
    // того, как подгрузятся актуальные факты из Firebase (см. watchFacts) — иначе можно на миг
    // показать устаревший захардкоженный текст, если владелец его уже поправил в админке.
    introAlreadySeenAtStart = !!localStorage.getItem(LS.introSeen);
    maybeShowIntro();
  }
  watchItems();
  watchFacts();
  watchViewCount();
  maybeCountView();
  watchBonusStars();
  loadRates();
}
