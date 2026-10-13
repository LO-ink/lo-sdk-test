import { Heading, Text, Stack } from "@lo-ink/ui";

export function SecretaryPage() {
  return (
    <section className="run-panel" aria-labelledby="secretary-heading">
      <Stack gap={3}>
        <Heading level={2} id="secretary-heading">
          Секретарь
        </Heading>
        <Text>
          В LO вы выбираете бота, доступные чаты и разрешения. Шаблонный
          автоответ и расписание остаются в настройках LO.
        </Text>
        <Text>
          Ответы AI и их одобрение настраиваются в самом боте. Проверяйте
          предложенный ответ в личном чате с ботом, затем проверьте его доставку
          на устройстве собеседника.
        </Text>
        <Text>
          Старый сценарий проверки черновиков в LO завершён. Его сохранённые
          результаты не переотправляются и не считаются новой проверкой.
        </Text>
        <a href="https://github.com/LO-ink/lo-bot-sdk">
          Разработка секретаря на LO Bot SDK
        </a>
      </Stack>
    </section>
  );
}
