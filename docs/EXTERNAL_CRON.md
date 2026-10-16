# Автоматичне оновлення ДТЕК без Cloudflare Workers

## Чому одного GitHub `schedule` недостатньо

16 жовтня 2026 р. GitHub Actions не створював жодного запуску типу
`schedule`, хоча cron було правильно налаштовано на кожні п’ять хвилин.
Отже, оновлення ДТЕК не можуть з’являтися самостійно, якщо не працює
планувальник. GitHub не гарантує, що такі запуски відбудуться.

Робочий варіант **без Workers** — окремий безплатний планувальник
[cron-job.org](https://cron-job.org), який кожні 5 хвилин надсилає
авторизований HTTP POST до GitHub `workflow_dispatch`.

Цей спосіб не запускає Docker, сервер, Cloudflare чи бота води,
а лише штатний `publish.yml` в GitHub. На GitHub залишаються всі
секрети Telegram, обробка графіків і захист від повторів.

## Налаштування один раз

1. GitHub → Settings → Developer settings →
   [Fine-grained personal access tokens](https://github.com/settings/personal-access-tokens/new):
   - Repository access: **Only select repositories** → `XOTT69/dtek`.
   - Repository permissions → **Actions: Read and write**.
   - Термін дії: бажано 90 днів або відповідно до прийнятої політики;
     **після спливу токен потрібно оновити**, інакше перевірки зупиняться.
   - Токен нікому не надсилати й не записувати в код або URL.
2. Увійти на [cron-job.org](https://console.cron-job.org/jobs).
   Створити cronjob і вказати:
   - **Title:** `DTEK Kyiv Oblast`.
   - **URL:** `https://api.github.com/repos/XOTT69/dtek/actions/workflows/publish.yml/dispatches`
   - **Schedule:** Every **5 minutes**, 24/7.
   - **Request method:** `POST`.
   - **Content-Type:** `application/json`.
   - **Request body:** `{"ref":"main"}`
   - **Custom headers:**
     - `Authorization: Bearer <YOUR_FINE_GRAINED_GITHUB_TOKEN>`
     - `Accept: application/vnd.github+json`
     - `X-GitHub-Api-Version: 2022-11-28`
   - Сповіщення про невдалі запити: увімкнути.
3. Натиснути **Test Run** в cron-job.org і перевірити HTTP
   **204 No Content** (або успішний **200**, якщо запит повертає
   деталі запуску). Помилка **401/403** означає неправильний токен
   чи права, **404** — неправильний шлях або недоступний workflow.
4. [GitHub Actions](https://github.com/XOTT69/dtek/actions):
   переконатися, що з’являються запуски з подією
   **workflow_dispatch**, а не лише `push`.
   Це й підтверджує, що зовнішній розклад реально працює.

## Що саме надходить у Telegram

- Новий підтверджений графік сьогодні / завтра.
- Повний оновлений графік після зміни хоча б однієї підгрупи.
- Потрібні повідомлення «⚠️ Коригування» при зміні плану.
- Офіційне введення / скасування екстрених чи аварійних обмежень.
- Офіційні оголошення Укренерго на завтра.

**Часових нагадувань за 30 хвилин немає**. Якщо графік не
змінювався — Telegram повідомлення не публікується.

GitHub Actions зберігає незалежний власний `schedule` як додатковий
резерв. Два одночасні запуски серіалізовані concurrency-групою
`dtek-publisher`; повідомлення про графік мають унікальні
відмітки для захисту від повторів.

## Безпека

cron-job.org — сторонній сервіс, який зберігатиме цей
обмежений токен. Не використовуйте основний GitHub токен із
повним доступом до репозиторіїв. За потреби токен можна
відкликати на сторінці GitHub. GitHub `GITHUB_TOKEN` і секрети
Telegram **ніколи** не передавати сторонньому планувальнику.

Таймер працюватиме тільки після того, як користувач сам
створить завдання на cron-job.org. Запис у GitHub і цей документ
самі по собі не активують зовнішній розклад.
