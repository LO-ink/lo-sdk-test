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
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="action-confirmation-title"
      onCancel={onCancel}
    >
      <h2 id="action-confirmation-title">{title}</h2>
      <p>{detail}</p>
      <div className="actions">
        <button className="secondary" onClick={onCancel} autoFocus>
          Отмена
        </button>
        <button onClick={onConfirm}>Продолжить</button>
      </div>
    </dialog>
  );
}
