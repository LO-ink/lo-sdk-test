# Деплой LO SDK Test

Workflow `.github/workflows/ci.yml` проверяет pull request. После слияния в `main` он публикует прошедший проверки контейнер и развёртывает его по неизменяемому digest. Ручной запуск workflow также разрешён только для текущего `main`.

## Однократная настройка сервера

1. Установите Docker Compose, git, curl, Python 3 и flock. Подключите внешнюю сеть `traefik-public` и DNS/TLS для адреса в `compose.vps.yml`.
2. Создайте `/opt/lo-sdk-test/runtime.env` с переменными из `.env.example`, доступными только администратору. Этот файл не передаётся через GitHub.
3. Установите `compose.vps.yml` как `/opt/lo-sdk-test/compose.yml`, `release.sh` как root-owned `/usr/local/sbin/lo-sdk-test-deploy` с режимом 0755. Изменения этого root-скрипта устанавливаются администратором после ревью.
4. Создайте пользователя `lo-sdk-deploy` с заблокированным паролем, без группы Docker. Разрешите sudo только для `/usr/local/sbin/lo-sdk-test-deploy`.
5. Для отдельного ключа GitHub установите forced command в `authorized_keys`:

```text
restrict,command="sudo -n /usr/local/sbin/lo-sdk-test-deploy \"$SSH_ORIGINAL_COMMAND\"" ssh-ed25519 <public key>
```

6. В environment `production` репозитория разрешите только ветку `main`. Добавьте secrets `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` (проверенный ключ SSH сервера), variables `DEPLOY_HOST`, `DEPLOY_USER`.
7. Перед первой автоматической выкладкой должен работать контейнер `web` в compose-проекте `lo-sdk-test`: он станет первой точкой отката. Зафиксируйте его образ в `deployment.env` как `SDK_TEST_IMAGE=...`.

GHCR может оставаться приватным. На сервер передаётся краткоживущий `GITHUB_TOKEN` с правом чтения пакетов через зашифрованный stdin; временный Docker config удаляется после загрузки образа. Пакет связан с репозиторием меткой OCI source. Отдельный постоянный токен реестра на сервере не хранится.

## Проверка и откат

Скрипт принимает только `deploy sha256:<digest> <40-character commit> <GitHub actor>`, сверяет текущий `main` и метки образа. Устаревшие задачи пропускаются. Блокировка исключает параллельное переключение контейнера. Если GitHub недоступен, выкладка завершается ошибкой до переключения.

Проверяется здоровье нового контейнера и ревизия на публичном HTTPS-адресе. Ошибка возвращает предыдущий образ. Успешный digest и commit записываются в `/opt/lo-sdk-test/current-release.json`; `deployment.env` содержит текущий образ. Для административных compose-команд используйте этот env-файл:

```sh
cd /opt/lo-sdk-test
docker compose --env-file deployment.env -f compose.yml ps
```

Для экстренного ручного отката администратор может указать сохранённый digest или локальный предыдущий образ через `SDK_TEST_IMAGE` и выполнить `docker compose -p lo-sdk-test -f compose.yml up -d --no-deps --wait web`. Другие сервисы не перезапускаются. После ручного отката обновите `deployment.env` и проверьте `/release.json`.

Смена DNS, runtime.env, Traefik или root-скрипта относится к настройке инфраструктуры, а не к автоматической выкладке приложения. Не удаляйте предыдущий образ до подтверждения новой версии.
