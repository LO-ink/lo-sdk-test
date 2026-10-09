import { Button } from "@lo-ink/ui";
import type { ReactNode } from "react";
import type { LaunchData } from "@lo-ink/miniapp-sdk";

export function LaunchDetails({
  launch,
  authenticated,
  locale,
  onOpenPhoto,
}: {
  launch?: LaunchData;
  authenticated: boolean;
  locale?: string;
  onOpenPhoto?: (url: string) => void;
}) {
  const photoUrl = launch?.user?.photoUrl;
  let validPhotoUrl = false;
  if (photoUrl) {
    try {
      const url = new URL(photoUrl);
      validPhotoUrl =
        url.protocol === "https:" && !url.username && !url.password;
    } catch {
      validPhotoUrl = false;
    }
  }
  const photo = !photoUrl ? undefined : validPhotoUrl ? (
    <Button
      variant="quiet"
      size="small"
      disabled={!onOpenPhoto}
      aria-label="Открыть фото пользователя"
      onClick={() => onOpenPhoto?.(photoUrl)}
    >
      Открыть фото
    </Button>
  ) : (
    "Недопустимый URL"
  );
  const rows: [string, ReactNode][] = [
    ["ID пользователя", launch?.user?.id],
    ["Имя", launch?.user?.firstName],
    ["Фамилия", launch?.user?.lastName],
    ["Имя пользователя", launch?.user?.username],
    ["Фото пользователя", photo],
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
