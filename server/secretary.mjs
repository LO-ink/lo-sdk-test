class FlowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Keep a terminal route for old clients without touching their durable state. */
export function createSecretaryFlow(configuration) {
  const ownerId = configuration.LO_SECRETARY_TEST_OWNER_ID;
  return async function execute(userId) {
    if (ownerId && userId !== ownerId)
      throw new FlowError(403, "Проверка недоступна этому владельцу");
    throw new FlowError(
      410,
      "Проверка черновиков в LO завершена. Ответами и их одобрением управляет бот.",
    );
  };
}
