# Архитектура

Один ES-модуль `app.js` на две страницы. Точка входа — `initApp({ isAdmin })` (конец файла):
тема → небо → отсчёт → Firebase → первый рендер → подписки на данные.

## Разделы app.js
| Раздел (маркер `// ====== … ======`) | Что делает |
|---|---|
| НАСТРОЙКИ | `CONFIG` (email владельца/хелпера, публичный web-конфиг Firebase, контакты), пресеты Ozon/WB, ключи `localStorage`, общий `state` |
| УТИЛИТЫ | `escapeHtml`, `linkifyText`, `renderNoteWithCopyBoxes`, тосты, `reservationKey` (hex имени дарителя) |
| ТЕМА | светлая/тёмная, анимация переключателя |
| НЕБО / ПАДАЮЩАЯ ЗВЕЗДА | фон: звёзды, солнце/луна, фаза луны |
| ПАСХАЛКА: КЛИК ПО ЗАГОЛОВКУ | буквы заголовка → «звёздный режим», бонусные звёзды `sky/bonusStars` с именами |
| СЧЁТЧИК ДО 1 ОКТЯБРЯ | отсчёт, календарь с `CALENDAR_START`/`BIRTHDAY_DATE`, факты дня (`facts`, HTML), квизы (`quizzes`), редакторы фактов/квизов для владельца |
| ВАЛЮТА ПРОСМОТРА | курсы `open.er-api.com` (кэш 12 ч в `localStorage`), конвертация USD/RUB/AMD, старые цены-строки |
| ХРАНЕНИЕ | `itemRef`/`factRef`/`quizRef` |
| «УМНОЕ» ЗАПОЛНЕНИЕ ПО ССЫЛКЕ | превью товара по URL через CORS-прокси (title, og:image, цена из JSON-LD) |
| МОДАЛЬНЫЕ ОКНА | `openModal`/`closeModal` |
| ВХОД ВЛАДЕЛЬЦА | Firebase init, Google sign-in, роли, загрузка фото в Storage, форма подарка, бронь/отмена брони, детальная карточка |
| РЕНДЕР | панель фильтров (сортировка, категории, валюта, «Ozon/WB»), сетка карточек, контакты, интро |
| СТАРТ | подписки `watchItems`, `watchReservations` (только хелпер), `watchFacts`, `watchQuizzes`, `watchBonusStars`, миграция старых броней |

## Роли
| Кто | Как определяется | Может |
|---|---|---|
| Гость | без входа, `index.html` | смотреть список, бронировать/отменять по имени, зажигать звёзды |
| Владелец | Google-вход на `admin.html`, `CONFIG.OWNER_EMAIL` | всё редактировать; статус брони не видит |
| Хелпер | Google-вход на `admin.html`, `CONFIG.HELPER_EMAIL` | видит имена дарителей, ничего не меняет |

Проверка ролей на клиенте — только интерфейс; реальные права — в `database.rules.json`.

## Данные (Realtime Database)
```
items/<id>            публичное чтение; title, link, images[] (или старое image), priceAmount/priceCurrency (или старое price),
                      category, note, pinned, postponed, allowMultiple,
                      reserved (bool) | reservedCount (число) — пишут гости по правилам
reservations/<id>/<n+hex(имя)> = "Имя"   читает только хелпер; гость пишет/удаляет свою запись
facts/<YYYY-MM-DD>    HTML факта дня (пишет владелец, рендер через innerHTML)
quizzes/<YYYY-MM-DD>  вопросы квиза
sky/bonusStars/<key>  { hue, opacity, left, top, name? } — пишут все
```
Storage: `items/<время>-<uuid>-<имя файла>` — фото подарков (загружает владелец).

## Потоки
1. **Бронь (одиночная):** `openReserveModal` → `update(ref(db))` атомарно: `reservations/<id>/<ключ>` = имя
   и `items/<id>/reserved = true`. Правило сверяет, что флаг и запись появляются вместе.
2. **Бронь (несколько дарителей):** то же, но `reservedCount` ±1.
3. **Отмена:** гость вводит имя → ключ из имени → удаление. Неверное имя = нет такого ключа = отказ правил.
4. **Миграция:** при входе владельца старые публичные `reservedBy`/`reservedByMulti` переносятся в `reservations`.
5. **Превью ссылки:** форма подарка → `fetchLinkPreview` → прокси по очереди → разбор HTML → поля формы.

## Внешние зависимости
- Firebase SDK 10.12.0 с `gstatic.com` (версия зафиксирована в импортах).
- `open.er-api.com` — курсы валют, без ключа.
- CORS-прокси: свой Worker `winter-dust-4aa9.leritosha.workers.dev` (исходник не в этом репо),
  `api.allorigins.win`, `api.cors.lol` — им уходят URL товаров, которые вводит владелец.

## Что менять под новый праздник
`BIRTHDAY_DATE`, `CALENDAR_START`, `DEFAULT_DAILY_FACTS`, тексты отсчёта/интро, `FIXED_CATEGORIES`,
`CONTACTS`, `LINK_PRESETS` (адреса ПВЗ) — всё в `app.js`. Данные в Firebase — отдельно.

## Известные ограничения
- Всё в одном файле `app.js`, без модулей и сборки; в Node целиком не загружается (импорты по URL),
  поэтому тесты вырезают чистые функции из исходника.
- Правила Firebase Storage не хранятся в репо.
- `localStorage` читается без `try/catch` при загрузке модуля (строки с `LS.viewCurrency`, `LS.introSeen`).
