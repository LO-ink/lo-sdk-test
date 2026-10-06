import { useState, type ReactNode } from "react";
import {
  AppIcon,
  Button,
  Cell,
  Checkbox,
  EmptyState,
  Heading,
  Inline,
  List,
  Stack,
  Switch,
  Text,
  TextField,
} from "@lo-ink/ui";

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
function Section({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className="ui-demo" aria-label={name}>
      <Heading level={3}>{name}</Heading>
      {children}
    </section>
  );
}
const iconSource =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#5969fc"/><path d="M18 17v30h15M45 17a10 15 0 1 0 0 30 10 15 0 1 0 0-30" fill="none" stroke="#fff" stroke-width="4"/></svg>',
  );

export function UiPage() {
  const [theme, setTheme] = useState<"host" | "light" | "dark">("host");
  const [clicks, setClicks] = useState(0);
  const [name, setName] = useState("");
  const [notifications, setNotifications] = useState(true);
  const [privateList, setPrivateList] = useState(false);
  const [created, setCreated] = useState(false);
  return (
    <div
      className={`ui-catalog${theme === "host" ? "" : " lo-ui-root"}`}
      data-lo-theme={theme === "host" ? undefined : theme}
    >
      <Stack gap={4}>
        <Heading level={2}>UI компоненты</Heading>
        <Text tone="secondary">
          Все компоненты @lo-ink/ui. Действия работают только на этой странице.
        </Text>
        <Inline gap={2} role="group" aria-label="Тема компонентов">
          {(["host", "light", "dark"] as const).map((value) => (
            <Button
              key={value}
              size="small"
              variant={theme === value ? "secondary" : "quiet"}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
            >
              {value === "host"
                ? "Как в LO"
                : value === "light"
                  ? "Светлая"
                  : "Тёмная"}
            </Button>
          ))}
        </Inline>
      </Stack>
      <div className="ui-demo-grid">
        <Section name="Button">
          <Text size="label" tone="secondary">
            Обычная · отключена · загрузка
          </Text>
          <Stack gap={3}>
            {(["primary", "secondary", "danger", "quiet"] as const).map(
              (variant) => (
                <Inline key={variant} gap={2}>
                  <Button
                    variant={variant}
                    onClick={() => setClicks(clicks + 1)}
                  >
                    {variant}
                  </Button>
                  <Button
                    variant={variant}
                    disabled
                    aria-label={`${variant}: отключена`}
                  >
                    Отключена
                  </Button>
                  <Button
                    variant={variant}
                    loading
                    loadingLabel="Загрузка"
                    aria-label={`${variant}: загрузка`}
                  >
                    Загрузка
                  </Button>
                </Inline>
              ),
            )}
            <Inline gap={2}>
              <Button
                size="small"
                leading={<CheckIcon />}
                onClick={() => setClicks(clicks + 1)}
              >
                Маленькая
              </Button>
              <Button
                variant="secondary"
                trailing={<CheckIcon />}
                onClick={() => setClicks(clicks + 1)}
              >
                С иконкой
              </Button>
            </Inline>
            <Button fullWidth onClick={() => setClicks(clicks + 1)}>
              Кнопка на всю ширину с длинным названием
            </Button>
            <Text size="caption" role="status">
              Нажатий: {clicks}
            </Text>
          </Stack>
        </Section>
        <Section name="TextField">
          <Stack gap={4}>
            <TextField
              label="Название"
              placeholder="Введите название"
              description="Минимум три символа"
              value={name}
              onChange={(event) => setName(event.target.value)}
              error={
                name && name.length < 3
                  ? "Слишком короткое название"
                  : undefined
              }
            />
            <TextField
              label="Поле с ошибкой"
              defaultValue="a"
              error="Проверьте значение"
            />
            <TextField
              label="Только чтение"
              value="Сохранённое значение"
              readOnly
            />
            <TextField label="Отключённое поле" value="Недоступно" disabled />
            <TextField
              label="Пароль"
              type="password"
              defaultValue="example"
              autoComplete="off"
            />
          </Stack>
        </Section>
        <Section name="Switch · Checkbox">
          <Stack gap={2}>
            <Switch
              label="Уведомления"
              description="Можно переключить"
              checked={notifications}
              onChange={(event) => setNotifications(event.target.checked)}
            />
            <Checkbox
              label="Закрытый список"
              description="Можно выбрать"
              checked={privateList}
              onChange={(event) => setPrivateList(event.target.checked)}
            />
            <Switch
              label="Отключённый switch: включён"
              defaultChecked
              disabled
            />
            <Switch label="Отключённый switch: выключен" disabled />
            <Checkbox
              label="Отключённый checkbox: выбран"
              defaultChecked
              disabled
            />
            <Checkbox label="Отключённый checkbox: пустой" disabled />
            <List headingLevel={4} label="Контролы без видимой подписи">
              <Cell
                title="Switch"
                trailingAction={
                  <Switch
                    label="Уведомления в строке"
                    labelHidden
                    checked={notifications}
                    onChange={(event) => setNotifications(event.target.checked)}
                  />
                }
              />
              <Cell
                title="Checkbox"
                trailingAction={
                  <Checkbox
                    label="Закрытый список в строке"
                    labelHidden
                    checked={privateList}
                    onChange={(event) => setPrivateList(event.target.checked)}
                  />
                }
              />
            </List>
          </Stack>
        </Section>
        <Section name="List · Cell">
          <List headingLevel={4} label="Примеры строк">
            <Cell
              title="Информация"
              subtitle="Строка без действия"
              trailing="1.0"
            />
            <Cell
              title="Открыть пример"
              subtitle="Длинная подпись переносится и остаётся видимой на узком экране"
              leading={<AppIcon size="small">LO</AppIcon>}
              onPress={() => setClicks(clicks + 1)}
              trailing="›"
            />
            <Cell
              title="Недоступное действие"
              disabled
              onPress={() => setClicks(clicks + 1)}
            />
            <Cell
              title="Отдельное действие"
              onPress={() => setClicks(clicks + 1)}
              trailingAction={
                <Button
                  size="small"
                  variant="quiet"
                  onClick={() => setClicks(clicks + 1)}
                >
                  Выбрать
                </Button>
              }
            />
          </List>
        </Section>
        <Section name="AppIcon">
          <Inline gap={4}>
            <AppIcon
              src={iconSource}
              alt="Пример значка LO: маленький"
              size="small"
            />
            <AppIcon src={iconSource} alt="Пример значка LO: обычный" />
            <AppIcon
              src={iconSource}
              alt="Пример значка LO: большой"
              size="large"
            />
            <AppIcon aria-label="Значок без изображения">LO</AppIcon>
          </Inline>
        </Section>
        <Section name="Heading · Text">
          <Stack gap={3}>
            <Heading level={4}>Заголовок</Heading>
            {(["body", "label", "caption"] as const).map((size) => (
              <Inline key={size} gap={3}>
                <Text size={size}>Основной · {size}</Text>
                <Text size={size} tone="secondary">
                  Вторичный
                </Text>
                <Text size={size} tone="danger">
                  Ошибка
                </Text>
              </Inline>
            ))}
          </Stack>
        </Section>
        <Section name="EmptyState">
          {created ? (
            <Stack gap={3}>
              <Text role="status">Пример создан</Text>
              <Button variant="secondary" onClick={() => setCreated(false)}>
                Показать пустое состояние
              </Button>
            </Stack>
          ) : (
            <EmptyState
              headingLevel={4}
              title="Пока ничего нет"
              description="Создайте пример, чтобы увидеть результат действия."
              icon={<AppIcon>LO</AppIcon>}
              action={
                <Button onClick={() => setCreated(true)}>Создать пример</Button>
              }
            />
          )}
          <EmptyState headingLevel={4} title="Без дополнительных элементов" />
        </Section>
        <Section name="Stack · Inline">
          <Stack gap={4}>
            <Text size="label" tone="secondary">
              Stack: вертикально, gap 4 (16 px)
            </Text>
            <Stack gap={4}>
              {["Первый", "Второй", "Третий"].map((label) => (
                <Text key={label} className="ui-layout-sample">
                  {label}
                </Text>
              ))}
            </Stack>
            <Text size="label" tone="secondary">
              Inline: с переносом, gap 2 (8 px)
            </Text>
            <Inline gap={2}>
              {["Первый", "Второй", "Третий", "Четвёртый"].map((label) => (
                <Text key={label} className="ui-layout-sample">
                  {label}
                </Text>
              ))}
            </Inline>
          </Stack>
        </Section>
      </div>
    </div>
  );
}
