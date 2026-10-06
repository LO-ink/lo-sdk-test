export type Interaction = {
  title: string;
  detail: string;
  action?: (text: string) => Promise<unknown>;
  actionLabel?: string;
  question?: string;
  input?: {
    label: string;
    placeholder?: string;
    value?: string;
    readOnly?: boolean;
    preserveFocus?: boolean;
  };
};
export type InteractionResult = {
  decision: "yes" | "no" | "skip";
  value?: unknown;
};
export type InteractionView = Interaction & {
  phase: "ready" | "busy" | "confirm";
  attempt: number;
  start: (text: string) => void;
  repeat: (text: string) => void;
  answer: (decision: InteractionResult["decision"]) => void;
};
export type Interact = (
  request: Interaction,
  signal: AbortSignal,
) => Promise<InteractionResult>;

// Native calls start directly inside the user's click, before any await.
// The runner's signal also releases a pending question on stop or timeout.
export function createInteraction(
  show: (view: InteractionView | null) => void,
): Interact {
  return (request, signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      let settled = false,
        value: unknown,
        busy = false;
      const finish = (result?: InteractionResult, error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        show(null);
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = () =>
        finish(undefined, signal.reason ?? new Error("Остановлено"));
      const view: InteractionView = {
        ...request,
        phase: request.action ? "ready" : "confirm",
        attempt: 0,
        answer: (decision) => {
          if (busy || (decision !== "skip" && view.phase !== "confirm")) return;
          finish({ decision, value });
        },
        start: (text) => {
          if (settled || busy || !request.action) return;
          busy = true;
          value = undefined;
          view.attempt += 1;
          view.phase = "busy";
          show({ ...view });
          let operation: Promise<unknown>;
          try {
            operation = request.action(text);
          } catch (error) {
            finish(undefined, error);
            return;
          }
          void Promise.resolve(operation).then(
            (result) => {
              if (settled) return;
              value = result;
              busy = false;
              if (!request.question) finish({ decision: "yes", value });
              else {
                view.phase = "confirm";
                show({ ...view });
              }
            },
            (error) => finish(undefined, error),
          );
        },
        repeat: (text) => {
          if (settled || busy || view.phase !== "confirm" || !request.action)
            return;
          if (!request.input) {
            view.start(text);
            return;
          }
          value = undefined;
          view.phase = "ready";
          show({ ...view });
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      show(view);
    });
}
