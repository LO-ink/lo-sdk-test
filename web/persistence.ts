export const persistenceUnavailable =
  "Сохранение недоступно. Автоматическая проверка и восстановление остановлены: нельзя надёжно сохранить результаты и обязательства очистки. Разрешите хранилище для этого приложения и откройте его заново. До этого доступны просмотр SDK и ручные проверки.";

// Access to the storage object itself may throw, even before a method is called.
// A failed boundary stays closed for this page lifetime; memory is not durable.
export function createRunPersistence(
  acquire: () => Storage = () => globalThis.localStorage,
) {
  let failed = false;
  let notify = () => {};
  function access<T>(operation: (storage: Storage) => T): T {
    if (!failed) {
      try {
        return operation(acquire());
      } catch {
        failed = true;
        notify();
      }
    }
    throw new Error(persistenceUnavailable);
  }
  const storage = {
    getItem: (key: string) => access((target) => target.getItem(key)),
    setItem: (key: string, value: string) =>
      access((target) => target.setItem(key, value)),
    removeItem: (key: string) => access((target) => target.removeItem(key)),
  };
  try {
    storage.getItem("sdk-test.last-run");
  } catch {
    // Startup renders the unavailable state instead of losing the whole app.
  }
  return {
    storage,
    get unavailable() {
      return failed;
    },
    subscribe(listener: () => void) {
      notify = listener;
      if (failed) listener();
      return () => {
        notify = () => {};
      };
    },
  };
}
