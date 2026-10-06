import type {
  MiniAppOperation,
  MiniAppOperationMap,
  Capability,
} from "@lo-ink/miniapp-sdk";
type Definition<K extends MiniAppOperation> = {
  label: string;
  capability: Capability;
  input: MiniAppOperationMap[K]["input"];
  caution?: string;
};
const key = "lo-sdk-test";
/** The mapped type forces a runnable scenario for every operation of the SDK. */
export const cases = {
  ready: { label: "Готовность", capability: "ready", input: undefined },
  close: {
    label: "Закрыть приложение",
    capability: "close",
    input: undefined,
    caution: "Приложение закроется. Сначала сохраните отчёт.",
  },
  expand: {
    label: "Развернуть панель",
    capability: "expand",
    input: undefined,
  },
  requestFullscreen: {
    label: "Полный экран",
    capability: "fullscreen",
    input: undefined,
  },
  exitFullscreen: {
    label: "Выйти из полного экрана",
    capability: "fullscreen",
    input: undefined,
  },
  hideKeyboard: {
    label: "Скрыть клавиатуру",
    capability: "hideKeyboard",
    input: undefined,
  },
  setOrientationLock: {
    label: "Зафиксировать ориентацию",
    capability: "orientation",
    input: { locked: true },
  },
  setButton: {
    label: "Кнопка приложения",
    capability: "mainButton",
    input: {
      button: "main",
      params: { text: "SDK Test", visible: true, active: true },
    },
  },
  setClosingConfirmation: {
    label: "Подтверждение закрытия",
    capability: "closingConfirmation",
    input: { enabled: true },
  },
  setVerticalSwipes: {
    label: "Вертикальные жесты",
    capability: "verticalSwipes",
    input: { enabled: true },
  },
  setHeaderColor: {
    label: "Цвет шапки",
    capability: "headerColor",
    input: { color: "#5969fc" },
  },
  setBackgroundColor: {
    label: "Цвет фона",
    capability: "backgroundColor",
    input: { color: "#f9fcff" },
  },
  setBottomBarColor: {
    label: "Цвет нижней панели",
    capability: "bottomBarColor",
    input: { color: "#ffffff" },
  },
  haptic: {
    label: "Виброотклик",
    capability: "haptics",
    input: { kind: "success" },
  },
  showPopup: {
    label: "Диалог",
    capability: "popup",
    input: {
      title: "SDK Test",
      message: "Проверка диалога LO",
      buttons: [{ id: "ok", kind: "ok" }],
    },
  },
  openLink: {
    label: "Открыть ссылку",
    capability: "openLink",
    input: { url: "https://lo.ink" },
  },
  sendData: {
    label: "Отправить данные боту",
    capability: "sendData",
    input: { data: "sdk-test" },
    caution: "Отправит тестовые данные и может закрыть приложение.",
  },
  switchInlineQuery: {
    label: "Встроенный поиск бота",
    capability: "switchInlineQuery",
    input: { query: "sdk-test", chatTypes: ["users", "bots", "groups"] },
  },
  readClipboard: {
    label: "Прочитать буфер обмена",
    capability: "clipboard",
    input: undefined,
  },
  getLocation: {
    label: "Получить геопозицию",
    capability: "location",
    input: undefined,
  },
  openLocationSettings: {
    label: "Настройки геопозиции",
    capability: "location",
    input: undefined,
  },
  getBiometryInfo: {
    label: "Информация о биометрии",
    capability: "biometry",
    input: undefined,
  },
  requestBiometryAccess: {
    label: "Разрешить биометрию",
    capability: "biometry",
    input: { reason: "Проверка SDK" },
  },
  authenticateBiometry: {
    label: "Проверить биометрию",
    capability: "biometry",
    input: { reason: "Проверка SDK" },
  },
  updateBiometryToken: {
    label: "Тестовый токен биометрии",
    capability: "biometry",
    input: { token: "sdk-test-only" },
  },
  openBiometrySettings: {
    label: "Настройки биометрии",
    capability: "biometry",
    input: undefined,
  },
  startAccelerometer: {
    label: "Запустить акселерометр",
    capability: "sensors",
    input: { refreshRate: 100 },
  },
  stopAccelerometer: {
    label: "Остановить акселерометр",
    capability: "sensors",
    input: undefined,
  },
  startGyroscope: {
    label: "Запустить гироскоп",
    capability: "sensors",
    input: { refreshRate: 100 },
  },
  stopGyroscope: {
    label: "Остановить гироскоп",
    capability: "sensors",
    input: undefined,
  },
  startDeviceOrientation: {
    label: "Запустить ориентацию",
    capability: "sensors",
    input: { refreshRate: 100, absolute: false },
  },
  stopDeviceOrientation: {
    label: "Остановить ориентацию",
    capability: "sensors",
    input: undefined,
  },
  downloadFile: {
    label: "Скачать тестовый файл",
    capability: "downloadFile",
    input: {
      url: new URL(
        "/fixtures/test.txt",
        globalThis.location?.origin ?? "https://example.test",
      ).href,
      fileName: "sdk-test.txt",
    },
  },
  openQrScanner: {
    label: "Сканер QR",
    capability: "qrScanner",
    input: { text: "Проверка SDK" },
  },
  closeQrScanner: {
    label: "Закрыть сканер QR",
    capability: "qrScanner",
    input: undefined,
  },
  requestWriteAccess: {
    label: "Согласие на сообщения",
    capability: "requestWriteAccess",
    input: undefined,
  },
  requestContact: {
    label: "Поделиться контактом",
    capability: "requestContact",
    input: undefined,
  },
  shareMessage: {
    label: "Поделиться подготовленным сообщением",
    capability: "shareMessage",
    input: { id: "" },
  },
  shareToStory: {
    label: "Поделиться в истории",
    capability: "shareToStory",
    input: {
      mediaUrl: new URL(
        "/icon.png",
        globalThis.location?.origin ?? "https://example.test",
      ).href,
    },
  },
  openInvoice: {
    label: "Открыть счёт",
    capability: "invoice",
    input: { url: "" },
    caution: "Укажите тестовый счёт. Не подтверждайте реальную оплату.",
  },
  cloudStorageSet: {
    label: "Записать в облако",
    capability: "cloudStorage",
    input: { key, value: "test" },
  },
  cloudStorageGet: {
    label: "Прочитать из облака",
    capability: "cloudStorage",
    input: { key },
  },
  cloudStorageGetMany: {
    label: "Прочитать несколько ключей",
    capability: "cloudStorage",
    input: { keys: [key] },
  },
  cloudStorageRemove: {
    label: "Удалить тестовый ключ",
    capability: "cloudStorage",
    input: { key },
  },
  cloudStorageRemoveMany: {
    label: "Удалить тестовые ключи",
    capability: "cloudStorage",
    input: { keys: [key] },
  },
  cloudStorageKeys: {
    label: "Ключи облачного хранилища",
    capability: "cloudStorage",
    input: undefined,
  },
  deviceStorageSet: {
    label: "Записать на устройство",
    capability: "deviceStorage",
    input: { key, value: "test" },
  },
  deviceStorageGet: {
    label: "Прочитать с устройства",
    capability: "deviceStorage",
    input: { key },
  },
  deviceStorageRemove: {
    label: "Удалить тестовый ключ устройства",
    capability: "deviceStorage",
    input: { key },
  },
  deviceStorageClear: {
    label: "Очистить хранилище тестового приложения",
    capability: "deviceStorage",
    input: undefined,
    caution: "Удалит все данные устройства только этого приложения.",
  },
  secureStorageSet: {
    label: "Записать в защищённое хранилище",
    capability: "secureStorage",
    input: { key, value: "test-not-a-secret" },
  },
  secureStorageGet: {
    label: "Прочитать защищённый ключ",
    capability: "secureStorage",
    input: { key },
  },
  secureStorageRestore: {
    label: "Восстановить защищённый ключ",
    capability: "secureStorage",
    input: { key },
  },
  secureStorageRemove: {
    label: "Удалить защищённый тестовый ключ",
    capability: "secureStorage",
    input: { key },
  },
  secureStorageClear: {
    label: "Очистить защищённое хранилище",
    capability: "secureStorage",
    input: undefined,
    caution: "Удалит все защищённые данные только этого тестового приложения.",
  },
} satisfies { [K in MiniAppOperation]: Definition<K> };
export const operationNames = Object.keys(cases) as MiniAppOperation[];
export const events = [
  "activated",
  "deactivated",
  "themeChanged",
  "viewportChanged",
  "safeAreaChanged",
  "contentSafeAreaChanged",
  "fullscreenChanged",
  "fullscreenFailed",
  "backButtonClicked",
  "mainButtonClicked",
  "secondaryButtonClicked",
  "settingsButtonClicked",
  "qrTextReceived",
  "qrScannerClosed",
  "accelerometerChanged",
  "accelerometerFailed",
  "gyroscopeChanged",
  "gyroscopeFailed",
  "orientationChanged",
  "orientationFailed",
] as const;
