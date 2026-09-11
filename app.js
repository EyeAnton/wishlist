import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getDatabase, ref, set, update, remove, onValue } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

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

const LS = {
  theme: "wishlist_theme",
  viewCurrency: "wishlist_view_currency",
  rates: "wishlist_rates_cache",
};

let IS_ADMIN = false;

const state = {
  items: [],
  isOwner: false,      // права на добавление/редактирование/удаление; имён дарителей не видит
  canSeeNames: false,  // хелпер (жена) — видит, кто что дарит, но не может менять список
  ownerEmail: null,
  loading: true,
  viewCurrency: localStorage.getItem(LS.viewCurrency) || "original",
  sortBy: "default", // "default" | "price_asc" | "price_desc"
  categoryFilter: "", // "" — все категории, иначе показываем только эту
};

const NO_CATEGORY = "Без категории";
const FIXED_CATEGORIES = ["Девайсы", "Настолки", "Кофе", "Подписки"];

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

function initTheme(){
  const saved = localStorage.getItem(LS.theme);
  applyTheme(saved);
  const btn = $("#themeToggle");
  if(btn){
    btn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme")
        || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem(LS.theme, next);
      applyTheme(next);
    });
  }
}

// ====== СЧЁТЧИК ДО 1 ОКТЯБРЯ ======
function daysWord(n){
  const mod10 = n % 10, mod100 = n % 100;
  if(mod100 >= 11 && mod100 <= 14) return "дней";
  if(mod10 === 1) return "день";
  if(mod10 >= 2 && mod10 <= 4) return "дня";
  return "дней";
}

function renderCountdown(){
  const el = $("#countdown");
  if(!el) return;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), 9, 1); // месяцы с 0 — 9 это октябрь
  if(target < today) target = new Date(now.getFullYear() + 1, 9, 1);
  // Бар "заполняется" весь месяц перед целевой датой — с 1-го числа предыдущего месяца.
  const start = new Date(target.getFullYear(), target.getMonth() - 1, 1);
  const dayMs = 1000 * 60 * 60 * 24;
  const totalDays = Math.round((target - start) / dayMs);
  const daysLeft = Math.round((target - today) / dayMs);
  const pct = Math.min(100, Math.max(0, (daysLeft / totalDays) * 100));

  const ticks = Array.from({ length: totalDays - 1 }, (_, i) =>
    `<span class="countdown-tick" style="left:${((i + 1) / totalDays) * 100}%"></span>`
  ).join("");

  const label = daysLeft <= 0 ? "Сегодня 1 октября! 🎉" : `${daysLeft} ${daysWord(daysLeft)} до 1 октября`;

  el.innerHTML = `
    <div class="countdown-label">${label}</div>
    <div class="countdown-bar" title="${escapeHtml(label)}">
      <div class="countdown-bar-fill" style="width:${pct}%"></div>
      ${ticks}
    </div>
  `;
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

async function fetchHtmlViaProxies(url){
  let lastError = null;
  for(const buildProxyUrl of HTML_PROXIES){
    try{
      const res = await fetchWithTimeout(buildProxyUrl(url), 9000);
      if(!res.ok) throw new Error("код " + res.status);
      const text = await res.text();
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
  return { title: match ? cleanupTitle(match[1]) : "", image: "", images: [], price: "" };
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

function initFirebase(){
  try{
    const fbApp = initializeApp(CONFIG.FIREBASE_CONFIG);
    fbAuth = getAuth(fbApp);
    db = getDatabase(fbApp);
  }catch(e){
    console.error("Firebase init failed", e);
  }
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
      <textarea id="fImages" placeholder="https://...">${escapeHtml(existingImages.join("\n"))}</textarea>
      <small>По одной ссылке на строку. Первая станет обложкой в списке.</small>
    </div>
    <div class="field">
      <label>Заметка</label>
      <textarea id="fNote">${escapeHtml(item.note)}</textarea>
    </div>
    <div class="error-text" id="itemError"></div>
    <div class="modal-actions">
      ${isEdit ? '<button class="danger left" id="deleteItemBtn">Удалить</button>' : ""}
      ${isEdit && item.reservedBy ? '<button class="secondary" id="unreserveBtn">Снять отметку «дарю»</button>' : ""}
      <button class="secondary" id="cancelItem">Отмена</button>
      <button id="saveItem">Сохранить</button>
    </div>
  `, overlay => {
    overlay.querySelector("#fTitle").focus();
    overlay.querySelector("#cancelItem").addEventListener("click", closeModal);

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
            await update(itemRef(item.id), { reservedBy: "" });
            closeModal();
            showToast("Отметка снята");
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
          const current = state.items.find(i => i.id === item.id);
          if(current && current.reservedBy) throw new Error("Этот подарок уже хотят подарить");
          await update(itemRef(item.id), { reservedBy: name });
          closeModal();
          showToast("Записали! Спасибо 🎉");
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
      if(!name || name.toLowerCase() !== (item.reservedBy||"").toLowerCase()){
        overlay.querySelector("#cancelError").textContent = "Имя не совпадает";
        return;
      }
      const btn = overlay.querySelector("#confirmCancelReserve");
      await withLoadingButton(btn, async () => {
        await update(itemRef(item.id), { reservedBy: "" });
        closeModal();
        showToast("Отменено");
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

  const reservedLine = (item.reservedBy && (state.isOwner || state.canSeeNames))
    ? `<div class="reserved-badge" style="display:inline-flex;margin-bottom:10px;">${
        state.canSeeNames ? `🎁 Хотят подарить: ${escapeHtml(item.reservedBy)}` : "🎁 Уже дарят"
      }</div>`
    : "";

  openModal(`
    <div class="detail-main-img">${mainImageHtml}</div>
    ${thumbsHtml}
    <h3>${escapeHtml(item.title)}</h3>
    ${price ? `<div class="card-price" style="font-size:1.15rem;margin-bottom:10px;">${escapeHtml(price)}</div>` : ""}
    ${reservedLine}
    ${item.note ? `<p class="card-note" style="white-space:pre-wrap;">${escapeHtml(item.note)}</p>` : ""}
    ${item.link ? `<div class="card-link" style="margin:10px 0;"><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">Открыть ссылку →</a></div>` : ""}
    ${renderContacts()}
    <div class="modal-actions" id="detailActions"></div>
  `, overlay => {
    overlay.querySelectorAll(".detail-thumb").forEach(thumb => {
      thumb.addEventListener("click", () => {
        overlay.querySelector("#detailMainImg").src = thumb.dataset.src;
        overlay.querySelectorAll(".detail-thumb").forEach(t => t.classList.remove("active"));
        thumb.classList.add("active");
      });
    });

    const actions = overlay.querySelector("#detailActions");
    if(state.isOwner){
      actions.innerHTML = `<button class="secondary" id="detailClose">Закрыть</button><button id="detailEdit">✎ Редактировать</button>`;
      actions.querySelector("#detailEdit").addEventListener("click", () => openItemModal(item));
    }else if(state.canSeeNames){
      actions.innerHTML = `<button class="secondary" id="detailClose">Закрыть</button>`;
    }else if(item.reservedBy){
      actions.innerHTML = `<button class="secondary" id="detailClose">Закрыть</button><button class="ghost" id="detailCancel">не я / отменить</button>`;
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

  const categories = getAllCategories();
  let visibleItems = state.categoryFilter
    ? state.items.filter(item => categoryOf(item) === state.categoryFilter)
    : state.items.slice();

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

  const filtersBar = `
    <div class="filters-bar">
      <select id="sortSelect">
        <option value="default"${state.sortBy === "default" ? " selected" : ""}>Порядок: по умолчанию</option>
        <option value="price_asc"${state.sortBy === "price_asc" ? " selected" : ""}>Цена: сначала дешёвые</option>
        <option value="price_desc"${state.sortBy === "price_desc" ? " selected" : ""}>Цена: сначала дорогие</option>
      </select>
      <select id="currencySelect" title="Валюта отображения">
        <option value="original"${state.viewCurrency === "original" ? " selected" : ""}>Как указано</option>
        <option value="USD"${state.viewCurrency === "USD" ? " selected" : ""}>USD $</option>
        <option value="RUB"${state.viewCurrency === "RUB" ? " selected" : ""}>RUB ₽</option>
        <option value="AMD"${state.viewCurrency === "AMD" ? " selected" : ""}>AMD</option>
      </select>
      <select id="categorySelect">
        <option value=""${state.categoryFilter ? "" : " selected"}>Все категории</option>
        ${categories.map(cat => `<option value="${escapeHtml(cat)}"${state.categoryFilter === cat ? " selected" : ""}>${escapeHtml(cat)}</option>`).join("")}
      </select>
    </div>
  `;

  const list = visibleItems.length
    ? `<div class="grid">${visibleItems.map(renderCard).join("")}</div>`
    : `<div class="empty-state"><h2>Ничего не найдено</h2><p>Попробуйте выбрать другую категорию.</p></div>`;

  el.innerHTML = filtersBar + list;

  const categorySelect = el.querySelector("#categorySelect");
  if(categorySelect){
    categorySelect.addEventListener("change", () => {
      state.categoryFilter = categorySelect.value;
      renderMain();
    });
  }
  const sortSelect = el.querySelector("#sortSelect");
  if(sortSelect){
    sortSelect.addEventListener("change", () => {
      state.sortBy = sortSelect.value;
      renderMain();
    });
  }
  const currencySelect = el.querySelector("#currencySelect");
  if(currencySelect){
    currencySelect.addEventListener("change", () => {
      state.viewCurrency = currencySelect.value;
      localStorage.setItem(LS.viewCurrency, state.viewCurrency);
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
    if(state.isOwner){
      card.querySelector(".editBtn")?.addEventListener("click", () => openItemModal(item));
    }else if(!state.canSeeNames){
      card.querySelector(".reserveBtn")?.addEventListener("click", () => openReserveModal(item));
      card.querySelector(".cancelReserveBtn")?.addEventListener("click", () => openCancelReserveModal(item));
    }
  });
}

// Мини-кнопки "написать в Telegram" — на случай вопросов про подарок или размер/цвет.
const TELEGRAM_ICON_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635.099-.002.321.023.465.14.121.098.153.23.169.324.016.093.036.306.02.472z"/></svg>`;

function renderContacts(){
  return `
    <div class="card-contacts">
      ${CONFIG.CONTACTS.map(c => `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" class="contact-link">${TELEGRAM_ICON_SVG} ${escapeHtml(c.name)}</a>`).join("")}
    </div>
  `;
}

function renderCard(item){
  const img = item.image
    ? `<img src="${escapeHtml(item.image)}" alt="" onerror="this.parentElement.innerHTML='🎁'">`
    : "🎁";
  const price = displayPrice(item);
  return `
    <div class="card" data-id="${escapeHtml(item.id)}">
      ${state.isOwner ? `<div class="owner-actions"><button class="secondary editBtn">✎</button></div>` : ""}
      <div class="card-img">${img}</div>
      <div class="card-body">
        <p class="card-title">${item.link
          ? `<a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>`
          : escapeHtml(item.title)}</p>
        ${price ? `<div class="card-price">${escapeHtml(price)}</div>` : ""}
        ${item.note ? `<p class="card-note">${escapeHtml(item.note)}</p>` : ""}
        <div class="card-footer">
          ${renderCardFooter(item)}
        </div>
        ${renderContacts()}
      </div>
    </div>
  `;
}

function renderCardFooter(item){
  // Владелец (получатель подарков) сюрприз не видит — только факт брони, без имени.
  // Хелпер (жена) видит имя, чтобы помогать координировать подарки, но список не редактирует.
  if(state.isOwner || state.canSeeNames){
    if(!item.reservedBy) return `<span style="color:var(--muted);font-size:.85rem;">Свободно</span>`;
    return state.canSeeNames
      ? `<span class="reserved-badge">🎁 Хотят подарить: ${escapeHtml(item.reservedBy)}</span>`
      : `<span class="reserved-badge">🎁 Уже дарят</span>`;
  }
  if(item.reservedBy){
    // Имя не показываем гостям — его же нужно ввести, чтобы отменить. Покажи мы его тут,
    // любой гость мог бы подсмотреть и отменить чужую отметку.
    return `
      <span class="reserved-badge">🎁 Уже дарят</span>
      <button class="ghost cancelReserveBtn" style="font-size:.78rem;">не я / отменить</button>
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

// ====== СТАРТ ======
export function initApp(opts){
  IS_ADMIN = !!(opts && opts.isAdmin);
  initTheme();
  initCountdown();
  initFirebase();
  renderAll();
  if(IS_ADMIN) initGoogleSignIn();
  watchItems();
  loadRates();
}
