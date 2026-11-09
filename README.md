# openwrt-zapret

Порт [zapret](https://github.com/bol-van/zapret) (bol-van) на OpenWrt: пакет для `opkg`/`apk` и веб-интерфейс **LuCI**
(*Службы → Zapret*) для управления им.

Исходников zapret в этом репозитории **нет**: при сборке OpenWrt сам скачивает их с GitHub
(`PKG_SOURCE_URL` + проверка `PKG_HASH`), собирает `nfqws`, `tpws`, `mdig`, `ip2net` под архитектуру роутера
и ставит родные скрипты zapret (файрвол, ipset/hostlist, `blockcheck.sh`) без изменений.

## Что внутри

| Каталог | Пакет | Содержимое |
|---|---|---|
| `zapret/` | `zapret` | Makefile (скачивает и собирает upstream), procd-init, генератор конфига из UCI, hotplug, cron-обновление списков, фоновые задачи |
| `luci-app-zapret/` | `luci-app-zapret`, `luci-i18n-zapret-ru` | JS-страницы LuCI, rpcd-плагин на ucode, ACL, меню, русский перевод |
| `build.sh` | — | сборка обоих пакетов на официальном SDK OpenWrt (нативно на Linux или в Docker) |

Версия zapret закреплена в [zapret/Makefile](zapret/Makefile) (`PKG_VERSION`/`PKG_HASH`): сейчас **72.13**.
Скрипты порта проверялись именно на ней.

## Сборка

Нужны Linux или Docker. На macOS — только Docker (`--docker`).

```sh
./build.sh                                  # x86/64, последний stable OpenWrt
./build.sh --target mediatek/filogic        # другой роутер
./build.sh --docker --target ramips/mt7621  # внутри Docker (macOS, любой Linux без зависимостей)
./build.sh --openwrt 24.10.8                # конкретная версия OpenWrt
./build.sh --zapret-version latest          # свежий релиз zapret с GitHub (не проверялся этим портом)
```

Что делает скрипт: определяет версию OpenWrt → скачивает SDK для платформы и проверяет sha256 → кладёт в SDK
пакеты из репозитория → подключает feeds `packages` и `luci` → `make package/zapret/compile
package/luci-app-zapret/compile`. Во время компиляции OpenWrt скачивает tarball zapret с
`codeload.github.com/bol-van/zapret` и сверяет хэш. Готовые пакеты — в `out/`:
`.ipk` (OpenWrt ≤ 24.10) или `.apk` (OpenWrt ≥ 25.12).

> **Mac на Apple Silicon.** SDK OpenWrt — x86_64-программа. В Docker на ARM она запускается через эмуляцию, и в
> эмуляции QEMU, на которой проверялся порт (Colima по умолчанию), кросс-компилятор SDK падает с сегфолтом. Используйте
> Docker Desktop или OrbStack (Rosetta), Colima с `--vm-type vz --vz-rosetta`, либо собирайте на x86_64 Linux / в CI.

Свою платформу смотрите в `/etc/openwrt_release` на роутере (`DISTRIB_TARGET`), например `ramips/mt7621`.

Без `build.sh`: добавьте этот репозиторий как feed в обычное дерево OpenWrt
(`src-link zapret /путь/к/openwrt-zapret`), затем `./scripts/feeds update zapret &&
./scripts/feeds install -a -p zapret` и выберите пакеты в `make menuconfig`
(*Network → Firewall → zapret*, *LuCI → Applications → luci-app-zapret*).

## Установка на роутер

```sh
# OpenWrt 25.12+ (apk)
apk add --allow-untrusted /tmp/zapret-*.apk /tmp/luci-app-zapret-*.apk /tmp/luci-i18n-zapret-ru-*.apk
# OpenWrt 24.10 и старше (opkg)
opkg install /tmp/zapret_*.ipk /tmp/luci-app-zapret_*.ipk /tmp/luci-i18n-zapret-ru_*.ipk
```

Зависимости (`libnetfilter-queue`, `curl`, `kmod-nft-queue`, …) подтянутся из репозиториев OpenWrt.
Сразу после установки zapret **выключен** и ничего не трогает: включите его в *Службы → Zapret → Настройки*.

## Использование

*Службы → Zapret*:

* **Состояние** — запущен ли сервис, процессы nfqws/tpws, применены ли правила файрвола, списки, журнал; кнопки Запустить / Остановить / Перезапустить / Обновить списки.
* **Настройки** — все параметры (вкладки Общие, NFQWS, TPWS, Списки, Дополнительно). Есть пресеты стратегий nfqws.
  «Сохранить и применить» пересоздаёт конфиг zapret и перезапускает сервис.
* **Списки** — редактор пользовательских списков (`zapret-hosts-user.txt`, исключения, ipban, автосписок) и загрузка списков с лога.
* **Подбор стратегии** — запуск `blockcheck.sh` в фоне с выводом в браузер (сервис на время теста останавливается).

Порядок для обычного случая: включить zapret → вкладка NFQWS → включить nfqws → запустить *Подбор стратегии* для
своих доменов → перенести найденные параметры в *nfqws options* → «Сохранить и применить».

### Командная строка

```sh
/etc/init.d/zapret start|stop|restart|reload|status
/etc/init.d/zapret update_lists        # скачать списки сейчас
/etc/init.d/zapret list_table          # таблица nftables zapret
/etc/init.d/zapret restart_fw          # только правила файрвола
logread -e zapret                       # журнал
uci show zapret                         # настройки
```

## Как это устроено

* **Источник настроек — UCI** (`/etc/config/zapret`, секция `main`). Родные скрипты zapret читают shell-файл `config`,
  поэтому `/usr/libexec/zapret/env.sh` генерирует `/etc/zapret/config`: `config.default` из upstream + значения из UCI
  + `extra_config` (произвольные строки в конец). Файл пересоздаётся автоматически при изменении UCI; руками его не правьте.
* Опции UCI называются как переменные upstream в нижнем регистре: `nfqws_opt` → `NFQWS_OPT`, `mode_filter` → `MODE_FILTER` и т.д.
  Любую переменную, для которой нет поля в LuCI, можно задать через `extra_config`.
* **Файрвол и демоны** — родная логика upstream (`init.d/openwrt/functions`, `common/*`), init-скрипт — адаптация
  upstream-овского `init.d/openwrt/zapret`. Правила nftables: таблица `inet zapret`.
* **Каталоги.** `/usr/share/zapret` — скрипты и данные upstream (только чтение), `/usr/bin` — бинарники,
  `/etc/zapret` — конфиг, списки (`ipset/`) и пользовательские скрипты (`init.d/openwrt/custom.d/`).
  Пользовательские списки сохраняются при sysupgrade (`/lib/upgrade/keep.d/zapret`).
* **Флаг `enabled`** определяет запуск при загрузке и реакцию на «Сохранить и применить». Кнопки Запустить/Остановить
  работают независимо от него.
* **Автообновление списков** — запись в cron (`/etc/crontabs/root`) при заданных `getlist` и `list_update_hour`.
* **LuCI** общается с роутером через ubus-объект `luci.zapret` (rpcd-плагин на ucode, `/usr/share/rpcd/ucode/zapret.uc`);
  пользовательский ввод проверяется по белым спискам и не попадает в командные строки.

## Совместимость

* OpenWrt **23.05, 24.10, 25.12** (нужны `rpcd-mod-ucode` и LuCI на JS). Основной режим — **nftables / fw4**.
* Режим iptables + fw3 (OpenWrt 21.02 и старше) перенесён из upstream, но **не проверялся**.
* Нужны ядро и пакеты с NFQUEUE (`kmod-nft-queue`) и тот flow offloading, который не мешает nfqws: см. опцию «Flow offloading».

## Что проверено, а что нет

Проверено:

* Бинарники `nfqws`, `tpws`, `mdig`, `ip2net` компилируются теми же флагами на musl (Alpine) и запускаются.
* Генерация конфига, init-скрипт (запуск/остановка/reload, загрузка при `enabled=0|1`), таблица nftables, hotplug, cron,
  фоновые задачи (`update-lists`, `blockcheck`: остановка группы процессов, возврат сервиса) — в контейнере с
  настоящим OpenWrt (procd, ubus, rpcd, busybox ash, nft).
* rpcd-плагин под настоящими `ucode` и `rpcd`; все четыре страницы LuCI в Chrome без ошибок JS; «Сохранить и применить»
  (перезапуск nfqws и новые правила nft за ~2 с), кнопки управления, редактор списков, запуск и остановка blockcheck.
* В настоящем buildroot SDK OpenWrt 25.12.6 (armsr/armv8): скачивание tarball zapret с GitHub и проверка `PKG_HASH`,
  разбор Makefile, установка файлов, `luci.mk`, компиляция перевода `.po → .lmo`, сборка `.apk` для `zapret`,
  `luci-app-zapret`, `luci-i18n-zapret-ru`.

**Не проверено:**

* Полная кросс-компиляция `nfqws`/`tpws` и сборка всей цепочки зависимостей на SDK. Компилятор SDK (x86_64) не запустился
  под эмуляцией на машине, где проводилась проверка (сегфолт `aarch64-openwrt-linux-musl-gcc`), поэтому шаг компиляции
  при проверке пакета был заменён заглушкой. Те же команды компиляции проверены на musl в Alpine (см. выше).
  Если `./build.sh` на вашей машине упадёт — пришлите последние строки вывода.
* Работа на физическом роутере, аппаратный flow offloading, IPv6, режим iptables + fw3.

## Диагностика

* `logread -e zapret` — журнал; `/etc/zapret/config` — итоговая конфигурация; `nft list table inet zapret` — правила.
* Сервис включён, но ничего не происходит — проверьте, что включён nfqws или tpws (подсказка видна на странице состояния).
* Сайты перестали открываться — остановите сервис кнопкой *Остановить* и подберите стратегию заново; для проверки
  по доменам используйте режим `hostlist` и свой список.
* `Flow offloading`: при включённом системном offloading (*Сеть → Файрвол*) nfqws не видит пакеты соединения после
  его установки; опции `software`/`hardware` создают исключения для обрабатываемых соединений.

## Обновление zapret

1. `./build.sh --zapret-version <версия>` — соберёт указанный релиз, либо
2. поправьте `PKG_VERSION` и `PKG_HASH` в [zapret/Makefile](zapret/Makefile)
   (`curl -L https://codeload.github.com/bol-van/zapret/tar.gz/v<версия> | sha256sum`).

После обновления сверьтесь с `docs/changes.txt` upstream: порт использует `init.d/openwrt/functions` и `config.default`
оригинала, а init-скрипт повторяет логику `init.d/openwrt/zapret`.

## Лицензия

Код порта (всё, кроме исходников zapret) — MIT, см. [LICENSE](LICENSE). Сам zapret — MIT (bol-van), скачивается при сборке.
