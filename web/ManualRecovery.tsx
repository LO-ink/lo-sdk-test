import { Button, Checkbox, Stack, Text, TextArea } from "@lo-ink/ui";
import { useState } from "react";
import {
  cleanupTicketExport,
  manualOnlyRecovery,
  type RecoveryTicket,
} from "./manual-recovery.ts";

export function ManualRecovery({
  ticket,
  disabled,
  onAttest,
}: {
  ticket: RecoveryTicket;
  disabled: boolean;
  onAttest?: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Stack gap={3}>
      <Button variant="secondary" onClick={() => setOpened(!opened)}>
        {opened ? "Скрыть данные очистки" : "Показать данные очистки"}
      </Button>
      {opened && (
        <>
          <Text size="label" tone="secondary">
            Скопируйте JSON из поля: в нём прежний владелец, все ключи, кнопки и
            исходные настройки. Если прежний аккаунт неизвестен или очистка ещё
            не выполнена, не подтверждайте её.
          </Text>
          <TextArea
            label="Полная запись очистки (JSON)"
            readOnly
            rows={10}
            value={cleanupTicketExport(ticket)}
          />
          {manualOnlyRecovery(ticket) && (
            <>
              <Checkbox
                label="Я удалил все перечисленные тестовые данные и восстановил настройки в прежнем приложении и аккаунте"
                checked={confirmed}
                disabled={disabled}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <Text size="caption" tone="secondary">
                Это ваше подтверждение внешней ручной очистки. SDK её не
                проверял. Исходная запись останется в локальном архиве; старые
                результаты не станут подтверждением текущих SDK.
              </Text>
              <Button
                disabled={disabled || !confirmed || !onAttest}
                onClick={onAttest}
              >
                Сохранить подтверждение ручной очистки
              </Button>
            </>
          )}
        </>
      )}
    </Stack>
  );
}
