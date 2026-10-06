import { Button, Heading, Text, Dialog, Stack } from "@lo-ink/ui";
import { useEffect, useRef } from "react";

export function ActionConfirmation({
  title,
  detail,
  onConfirm,
  onCancel,
}: {
  title: string;
  detail: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <Dialog
      ref={dialog}
      className="modal"
      aria-labelledby="action-confirmation-title"
      onCancel={onCancel}
    >
      <Stack gap={4}>
        <Heading level={2} id="action-confirmation-title">
          {title}
        </Heading>
        <Text tone="secondary" size="label">
          {detail}
        </Text>
        <div className="actions">
          <Button variant="secondary" onClick={onCancel} autoFocus>
            Отмена
          </Button>
          <Button onClick={onConfirm}>Продолжить</Button>
        </div>
      </Stack>
    </Dialog>
  );
}
