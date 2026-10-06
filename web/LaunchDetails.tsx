import type { LaunchData } from "@lo-ink/miniapp-sdk";

export function LaunchDetails({
  launch,
  authenticated,
  locale,
}: {
  launch?: LaunchData;
  authenticated: boolean;
  locale?: string;
}) {
  const rows = [
    ["ID пользователя", launch?.user?.id],
    ["Имя", launch?.user?.firstName],
    ["Фамилия", launch?.user?.lastName],
    ["Имя пользователя", launch?.user?.username],
    ["Фото пользователя", launch?.user?.photoUrl],
    ["Язык интерфейса LO", locale],
    ["Язык в подписанных данных", launch?.user?.languageCode],
    ["Параметр запуска", launch?.startParam],
    ["Тип чата", launch?.chatType],
    ["Время подписи (Unix)", launch?.authDate],
    ["ID приложения", launch?.appId],
    ["ID запроса", launch?.queryId],
    ["Подпись на сервере", authenticated ? "Проверена" : "Не проверена"],
  ];
  return (
    <dl className="launch-details">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value === undefined || value === "" ? "Не передано" : value}</dd>
        </div>
      ))}
    </dl>
  );
}
