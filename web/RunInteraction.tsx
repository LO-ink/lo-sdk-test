import { useEffect, useId, useRef, useState } from "react";
import type { InteractionView } from "./interaction.ts";
export function RunInteraction({
  view,
  onStop,
}: {
  view: InteractionView;
  onStop: () => void;
}) {
  const [text, setText] = useState(view.input?.value ?? "");
  const inputId = useId();
  const inlineStart = Boolean(view.input?.preserveFocus);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "nearest" });
  }, [view.title]);
  const startButton = view.phase === "ready" && (
    <button
      className="run-start"
      onPointerDown={(event) => {
        if (view.input?.preserveFocus) event.preventDefault();
      }}
      onClick={() => view.start(text)}
      disabled={Boolean(view.input && !text.trim())}
    >
      {view.actionLabel ?? "Проверить"}
    </button>
  );
  return (
    <section
      className="run-interaction group"
      aria-labelledby="interaction-title"
      aria-busy={view.phase === "busy"}
    >
      <div className="interaction-content">
        <h2 id="interaction-title" ref={heading} tabIndex={-1}>
          {view.title}
        </h2>
        {!(view.phase === "confirm" && view.detail === view.question) && (
          <p className="interaction-description">{view.detail}</p>
        )}
        {view.input && (
          <div className="interaction-input">
            <label htmlFor={inputId}>{view.input.label}</label>
            <div
              className={`interaction-input-controls${inlineStart ? " preserve-focus" : ""}${inlineStart && view.phase === "ready" ? " inline-action" : ""}`}
            >
              <input
                id={inputId}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={view.input.placeholder}
                readOnly={view.input.readOnly}
                disabled={view.phase !== "ready" && !view.input.preserveFocus}
                autoComplete="off"
                spellCheck={false}
              />
              {inlineStart && startButton}
            </div>
          </div>
        )}
        {view.phase === "confirm" && (
          <p className="interaction-question">
            {view.question ?? "Подтверждаете результат?"}
          </p>
        )}
        {view.phase === "confirm" && view.attempt > 1 && (
          <p className="interaction-description" role="status">
            Попытка {view.attempt}. Проверьте результат повторного действия.
          </p>
        )}
      </div>
      <div className="interaction-actions">
        {!inlineStart && startButton}
        {view.phase === "busy" && (
          <p role="status">
            {view.attempt > 1 ? "Повторяем действие…" : "Ожидаем ответ LO…"}
          </p>
        )}
        {view.phase === "confirm" && (
          <div className="interaction-answers">
            <button onClick={() => view.answer("yes")}>Да</button>
            <button className="secondary" onClick={() => view.answer("no")}>
              Нет
            </button>
          </div>
        )}
        <div className="interaction-tools">
          {view.phase === "confirm" && view.action && (
            <button
              onClick={() => view.repeat(text)}
              aria-label="Повторить действие"
            >
              Повторить
            </button>
          )}
          {view.phase !== "busy" && (
            <button onClick={() => view.answer("skip")}>Пропустить</button>
          )}
          <button onClick={onStop}>Остановить</button>
        </div>
      </div>
    </section>
  );
}
